const mongoose = require("mongoose");

// "I would like to improve this project." A connection asks the owner (with a proper explanation),
// and once approved works on a copy and sends back ONLY their changes, again with an explanation.
// Nothing reaches the project until the owner has looked at the changes and merged them.
//
//   asking -> approved -> submitted -> merged
//                 |           |-> changes-requested -> submitted ...
//   any open state -> declined (by the owner) | withdrawn (by the author)
const changeSchema = new mongoose.Schema(
    {
        path: { type: String, required: true },
        kind: { type: String, enum: ["added", "changed", "removed"], required: true },
        hash: { type: String }, // new content (added / changed)
        size: { type: Number },
        csize: { type: Number },
        crc: { type: Number },
        baseHash: { type: String }, // what the file was in the version they started from (changed / removed)
    },
    { _id: false },
);

const projectContributionSchema = new mongoose.Schema(
    {
        project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
        author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        title: { type: String, required: true, trim: true, minLength: 5, maxLength: 100 },
        intent: { type: String, required: true, trim: true, minLength: 30, maxLength: 1500 }, // what and why, before starting
        status: {
            type: String,
            enum: ["asking", "approved", "submitted", "merging", "changes-requested", "merged", "declined", "withdrawn"],
            default: "asking",
        },
        explanation: { type: String, trim: true, maxLength: 2000, default: "" }, // what was changed and why, when submitting
        decisionNote: { type: String, trim: true, maxLength: 500, default: "" }, // the owner's last reply
        decidedAt: { type: Date },
        baseVersion: { type: Number }, // the version the changes were made on top of
        changes: { type: [changeSchema], default: [] },
        summary: {
            added: { type: Number, default: 0 },
            changed: { type: Number, default: 0 },
            removed: { type: Number, default: 0 },
        },
        submittedAt: { type: Date },
        mergedVersion: { type: Number },
        authorSeen: { type: String }, // the last status the author has looked at (drives their "the owner replied" notification)
    },
    { timestamps: true },
);

projectContributionSchema.index({ project: 1, status: 1, createdAt: -1 });
projectContributionSchema.index({ author: 1, project: 1, status: 1 });
projectContributionSchema.index({ "changes.hash": 1 }); // "is this stored file still needed by a pending change?"

module.exports = mongoose.model("ProjectContribution", projectContributionSchema);
