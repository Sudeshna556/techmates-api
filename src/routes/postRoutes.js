const express = require("express");
const postRouter = express.Router();

const { userAuth } = require("../middlewares/auth");
const readImageBody = require("../middlewares/readImageBody");
const Post = require("../models/post");
const {
    detectImageExtension,
    saveImage,
    uploadUrl,
    ownedUploadFilename,
    uploadExists,
    deleteUploadedImage,
} = require("../utils/uploads");

const MAX_TEXT = 1000;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 30;
const IMAGE_FOLDER = "posts";

const isId = (value) => typeof value === "string" && /^[0-9a-f]{24}$/i.test(value);

// Delete an uploaded post image, unless some post still uses that file.
const deleteImageIfUnused = async (url, userId) => {
    const filename = ownedUploadFilename(url, userId, IMAGE_FOLDER);
    if (!filename) return;
    const inUse = await Post.exists({ image: new RegExp(`/${filename.replace(".", "\\.")}$`) });
    if (!inUse) await deleteUploadedImage(url, userId, IMAGE_FOLDER);
};

// the shape the frontend gets for a post
const toView = (post, meId) => {
    const likes = post.likes || [];
    const author = post.author && post.author._id ? post.author : null; // null if the author no longer exists
    return {
        _id: post._id,
        text: post.text,
        image: post.image || "",
        createdAt: post.createdAt,
        author: author ? { _id: author._id, name: author.name, profilePicture: author.profilePicture } : null,
        likeCount: likes.length,
        likedByMe: likes.some((id) => id.toString() === meId),
        isMine: Boolean(author) && author._id.toString() === meId,
    };
};

// GET /posts?before=<postId>&limit=10  -> newest first; pass nextCursor back as `before` for the next page
// Add author=me (or an author's id) to get only that person's posts (used by the profile pages).
postRouter.get("/posts", userAuth, async (req, res) => {
    try {
        const meId = req.user._id.toString();
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
        const filter = {};
        if (req.query.author !== undefined) {
            if (req.query.author === "me") filter.author = req.user._id;
            else if (isId(req.query.author)) filter.author = req.query.author;
            else return res.status(400).json({ error: "Invalid author" });
        }
        if (req.query.before !== undefined) {
            if (!isId(req.query.before)) return res.status(400).json({ error: "Invalid cursor" });
            filter._id = { $lt: req.query.before };
        }
        const rows = await Post.find(filter)
            .sort({ _id: -1 })
            .limit(limit + 1) // one extra row tells us whether there is another page
            .populate("author", "name profilePicture")
            .lean();
        const hasMore = rows.length > limit;
        const posts = rows.slice(0, limit).map((row) => toView(row, meId));
        res.json({ posts, hasMore, nextCursor: hasMore ? posts[posts.length - 1]._id : null });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: "Could not load posts" });
    }
});

// POST /posts/image  (raw image bytes) -> { url }.  Upload first, then attach the url when creating the post.
postRouter.post("/posts/image", userAuth, readImageBody, async (req, res) => {
    try {
        const ext = detectImageExtension(req.body);
        if (!ext) return res.status(400).json({ error: "That file is not a valid JPG, PNG, GIF or WebP image" });
        const url = await saveImage(req, req.user._id.toString(), req.body, ext, IMAGE_FOLDER);
        res.status(201).json({ url });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: "Could not upload the image" });
    }
});

// DELETE /posts/image  { url }  -> throw away an uploaded image that never made it into a post
postRouter.delete("/posts/image", userAuth, async (req, res) => {
    try {
        const userId = req.user._id.toString();
        if (!ownedUploadFilename(req.body?.url, userId, IMAGE_FOLDER)) {
            return res.status(400).json({ error: "Invalid image" });
        }
        await deleteImageIfUnused(req.body.url, userId);
        res.json({ message: "Image removed" });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: "Could not remove the image" });
    }
});

// POST /posts  { text, image? }
postRouter.post("/posts", userAuth, async (req, res) => {
    try {
        const user = req.user;
        const userId = user._id.toString();
        const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
        if (text.length > MAX_TEXT) {
            return res.status(400).json({ error: `A post can be at most ${MAX_TEXT} characters` });
        }

        let image = "";
        if (req.body?.image) {
            // only images this user uploaded (and that still exist) can be attached
            const filename = ownedUploadFilename(req.body.image, userId, IMAGE_FOLDER);
            if (!filename || !uploadExists(filename, IMAGE_FOLDER)) {
                return res.status(400).json({ error: "Invalid image" });
            }
            image = uploadUrl(req, filename, IMAGE_FOLDER);
        }
        if (!text && !image) {
            return res.status(400).json({ error: "Write something or add an image" });
        }

        const post = await Post.create({ author: user._id, text, image });
        const author = { _id: user._id, name: user.name, profilePicture: user.profilePicture };
        res.status(201).json({ message: "Posted", post: toView({ ...post.toObject(), author }, userId) });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: "Could not create the post" });
    }
});

// PUT /posts/:id/like  and  DELETE /posts/:id/like  (safe to repeat: you can't like twice)
const setLike = (add) => async (req, res) => {
    try {
        const { id } = req.params;
        if (!isId(id)) return res.status(404).json({ error: "Post not found" });
        const userId = req.user._id;
        const update = add ? { $addToSet: { likes: userId } } : { $pull: { likes: userId } };
        const post = await Post.findByIdAndUpdate(id, update, { new: true }).select("likes").lean();
        if (!post) return res.status(404).json({ error: "Post not found" });
        res.json({ likeCount: post.likes.length, likedByMe: add });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: "Could not update the like" });
    }
};
postRouter.put("/posts/:id/like", userAuth, setLike(true));
postRouter.delete("/posts/:id/like", userAuth, setLike(false));

// DELETE /posts/:id  (author only)
postRouter.delete("/posts/:id", userAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isId(id)) return res.status(404).json({ error: "Post not found" });
        const userId = req.user._id.toString();
        const post = await Post.findById(id);
        if (!post) return res.status(404).json({ error: "Post not found" });
        if (post.author.toString() !== userId) {
            return res.status(403).json({ error: "You can only delete your own posts" });
        }
        await post.deleteOne();
        await deleteImageIfUnused(post.image, userId); // (after the post is gone, so it no longer counts as "in use")
        res.json({ message: "Post deleted" });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: "Could not delete the post" });
    }
});

module.exports = postRouter;
