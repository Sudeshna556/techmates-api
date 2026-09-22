const mongoose = require("mongoose");

const RETENTION_SECONDS = 90 * 24 * 60 * 60; // the log keeps 90 days

// Who did what to a project. Only the owner can read it.
const projectActivitySchema = new mongoose.Schema({
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: {
        type: String,
        enum: ["upload", "view", "fetch", "block", "unblock", "ask", "approve", "decline", "request-changes", "submit", "merge", "withdraw"],
        required: true,
    },
    target: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: Date, default: Date.now, expires: RETENTION_SECONDS },
});

projectActivitySchema.index({ project: 1, at: -1 });

module.exports = mongoose.model("ProjectActivity", projectActivitySchema);
