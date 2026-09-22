"use strict";
// Chat between two devs who are connected: one conversation per pair, plain text (code blocks are drawn by the
// screen) and, optionally, a card that shares one of your own projects.

const express = require("express");
const { userAuth } = require("../middlewares/auth");
const Message = require("../models/message");
const Project = require("../models/project");
const ProjectAccess = require("../models/projectAccess");
const User = require("../models/userSchema");
const { ProjectError } = require("../utils/projectIngest");
const { isId, str, wrap, isConnected, friendIds, userView, oneLine } = require("./projectCommon");

const chatRouter = express.Router();

const MAX_TEXT = 10000;
const PAGE = 50;
const MAX_PER_MINUTE = 30; // stops a runaway script, far above what a person types
const MAX_CHATS = 200;

const pairOf = (a, b) => [a.toString(), b.toString()].sort().join(":");

// Only people you are connected with can be messaged. Strangers, people who are not connected and people who
// do not exist all get the same answer.
async function requireFriend(req) {
    const otherId = req.params.userId;
    const notFound = new ProjectError(404, "Developer not found");
    if (!isId(otherId) || otherId === req.user._id.toString()) throw notFound;
    if (!(await isConnected(req.user._id, otherId))) throw notFound;
    const other = await User.findById(otherId).select("name profilePicture");
    if (!other) throw notFound;
    return other;
}

const messageView = (m) => ({
    _id: m._id,
    from: m.from,
    to: m.to,
    text: m.text,
    project: m.project ? { _id: m.project, name: m.projectName } : null,
    createdAt: m.createdAt,
});

const preview = (m) => (m.text ? oneLine(m.text, 120) : m.projectName ? `Shared ${m.projectName}` : "");

// GET /chats -> every dev you are connected with, latest conversation first
chatRouter.get("/chats", userAuth, wrap(async (req, res) => {
    const me = req.user._id;
    const ids = (await friendIds(me)).slice(0, MAX_CHATS);
    const people = ids.length ? await User.find({ _id: { $in: ids } }).select("name profilePicture").lean() : [];
    const chats = await Promise.all(
        people.map(async (person) => {
            const pair = pairOf(me, person._id);
            const [last, unread] = await Promise.all([Message.findOne({ pair }).sort({ _id: -1 }).lean(), Message.countDocuments({ pair, to: me, readAt: null })]);
            return {
                user: userView(person),
                last: last ? { text: preview(last), mine: last.from.toString() === me.toString(), at: last.createdAt } : null,
                unread,
            };
        }),
    );
    // conversations first (newest on top), then devs you have not written to yet, A to Z
    chats.sort((a, b) => {
        if (a.last && b.last) return new Date(b.last.at) - new Date(a.last.at);
        if (a.last) return -1;
        if (b.last) return 1;
        return (a.user.name || "").localeCompare(b.user.name || "");
    });
    res.json({ chats, unread: chats.reduce((sum, c) => sum + c.unread, 0) });
}));

// GET /chats/:userId/messages           the latest messages (oldest first), and marks them read
// GET /chats/:userId/messages?after=ID  only what is newer than ID (what the open screen asks for every few seconds)
// GET /chats/:userId/messages?before=ID an older page
chatRouter.get("/chats/:userId/messages", userAuth, wrap(async (req, res) => {
    const me = req.user._id;
    const other = await requireFriend(req);
    const pair = pairOf(me, other._id);
    const after = str(req.query.after);
    const before = str(req.query.before);
    if ((after && !isId(after)) || (before && !isId(before))) throw new ProjectError(400, "Bad message id");

    let rows;
    let hasMore = false;
    if (after) {
        rows = await Message.find({ pair, _id: { $gt: after } }).sort({ _id: 1 }).limit(200).lean();
    } else {
        const filter = before ? { pair, _id: { $lt: before } } : { pair };
        const newest = await Message.find(filter).sort({ _id: -1 }).limit(PAGE + 1).lean();
        hasMore = newest.length > PAGE;
        rows = newest.slice(0, PAGE).reverse();
    }

    if (!before) await Message.updateMany({ pair, to: me, readAt: null }, { $set: { readAt: new Date() } });

    // the newest of MY messages they have opened, for the "Seen" mark
    const seen = await Message.findOne({ pair, from: me, readAt: { $ne: null } }).sort({ _id: -1 }).select("_id").lean();
    res.json({ user: userView(other), messages: rows.map(messageView), hasMore, seenUpTo: seen ? seen._id : null });
}));

// POST /chats/:userId/messages  { text, projectId? }
chatRouter.post("/chats/:userId/messages", userAuth, wrap(async (req, res) => {
    const me = req.user._id;
    const other = await requireFriend(req);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const text = str(body.text).trim();
    if (text.length > MAX_TEXT) throw new ProjectError(400, `Messages can be up to ${MAX_TEXT} characters`);

    let project = null;
    if (body.projectId !== undefined && body.projectId !== null && body.projectId !== "") {
        if (!isId(str(body.projectId))) throw new ProjectError(400, "Choose one of your projects to share");
        project = await Project.findById(body.projectId);
        if (!project || project.owner.toString() !== me.toString()) throw new ProjectError(400, "You can only share your own projects");
        if (project.visibility === "private") throw new ProjectError(400, "That project is hidden from your devs. Turn on \"Show this project to my devs\" first, then share it.");
        const blocked = await ProjectAccess.findOne({ project: project._id, user: other._id, status: "blocked" });
        if (blocked) throw new ProjectError(400, `${other.name} is blocked from that project, so they could not open it. Unblock them under Manage first.`);
    }
    if (!text && !project) throw new ProjectError(400, "Write a message first");

    const recent = await Message.countDocuments({ from: me, createdAt: { $gt: new Date(Date.now() - 60 * 1000) } });
    if (recent >= MAX_PER_MINUTE) throw new ProjectError(429, "You are sending messages very quickly. Wait a moment and try again.");

    const message = await Message.create({
        pair: pairOf(me, other._id),
        from: me,
        to: other._id,
        text,
        project: project ? project._id : undefined,
        projectName: project ? project.name : "",
    });
    res.status(201).json({ message: messageView(message) });
}));

module.exports = chatRouter;
