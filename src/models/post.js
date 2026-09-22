const mongoose = require("mongoose");

const postSchema = new mongoose.Schema(
    {
        author: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        text: {
            type: String,
            trim: true,
            maxLength: [1000, "A post can be at most 1000 characters"],
            default: "",
        },
        // URL of an image uploaded through POST /posts/image (optional)
        image: {
            type: String,
            default: "",
        },
        // ids of the users who liked the post
        likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    },
    { timestamps: true }
);

module.exports = mongoose.model("Post", postSchema);
