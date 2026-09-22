const mongoose = require("mongoose");

// One snapshot of a project: just a list of file fingerprints (the content is stored once, by hash).
const fileSchema = new mongoose.Schema(
    {
        path: { type: String, required: true },
        hash: { type: String, required: true }, // sha-256 of the content = the blob's name
        size: { type: Number, required: true }, // bytes, uncompressed
        csize: { type: Number, required: true }, // bytes as stored (raw deflate)
        crc: { type: Number, required: true }, // crc-32, needed to copy the stored data straight into a zip
    },
    { _id: false },
);

const projectVersionSchema = new mongoose.Schema(
    {
        project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
        number: { type: Number, required: true },
        message: { type: String, trim: true, maxLength: 200, default: "" },
        files: { type: [fileSchema], default: [] },
        fileCount: { type: Number, default: 0 },
        bytes: { type: Number, default: 0 },
        summary: {
            added: { type: Number, default: 0 },
            changed: { type: Number, default: 0 },
            removed: { type: Number, default: 0 },
        },
        overrides: { type: Number, default: 0 }, // suspected secrets the owner chose to share anyway
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        contributedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // set when the owner merged someone's contribution
        contribution: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectContribution" },
    },
    { timestamps: { createdAt: true, updatedAt: false } },
);

projectVersionSchema.index({ project: 1, number: 1 }, { unique: true });
projectVersionSchema.index({ "files.hash": 1 }); // "is this stored file still used by any version?"

module.exports = mongoose.model("ProjectVersion", projectVersionSchema);
