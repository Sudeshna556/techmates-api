const mongoose = require("mongoose");

// A shared project. Its files live in versions (see projectVersion.js); the blobs live on disk.
// Everybody the owner is connected with may LOOK at it (unless it is private); taking a copy or
// changing anything needs the owner's approval (see projectContribution.js).
const projectSchema = new mongoose.Schema(
    {
        owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
        name: { type: String, required: true, trim: true, minLength: 1, maxLength: 60 },
        description: { type: String, trim: true, maxLength: 300, default: "" },
        visibility: { type: String, enum: { values: ["friends", "private"], message: "{VALUE} is not a valid visibility" }, default: "friends" },
        openDownloads: { type: Boolean, default: false }, // true: any connection may download without asking first
        versionSeq: { type: Number, default: 0 }, // last version NUMBER handed out (a failed upload can leave a gap)
        latestVersion: { type: Number, default: 0 }, // newest version that really exists
        fileCount: { type: Number, default: 0 },
        bytes: { type: Number, default: 0 },
    },
    { timestamps: true },
);

module.exports = mongoose.model("Project", projectSchema);
