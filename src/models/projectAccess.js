const mongoose = require("mongoose");

// One record per person per project, created only when there is something to remember:
// the owner blocked them, or they downloaded a copy (so "only what changed" knows their baseline).
// Everybody else the owner is connected with can view the project without a record.
const projectAccessSchema = new mongoose.Schema(
    {
        project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        status: { type: String, enum: ["active", "blocked"], default: "active" },
        blockedAt: { type: Date },
        lastFetchedVersion: { type: Number, default: null },
    },
    { timestamps: true },
);

projectAccessSchema.index({ project: 1, user: 1 }, { unique: true });
projectAccessSchema.index({ user: 1, status: 1 });

module.exports = mongoose.model("ProjectAccess", projectAccessSchema);
