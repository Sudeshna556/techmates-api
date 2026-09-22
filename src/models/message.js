const mongoose = require("mongoose");

// One chat message between two connected devs. Every pair has one conversation, found by `pair`
// (the two ids, sorted, joined with ":"), so both people's messages live in the same thread.
const messageSchema = new mongoose.Schema(
    {
        pair: { type: String, required: true },
        from: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        to: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        text: { type: String, default: "", maxlength: 10000 },
        // a shared project card (the name is copied so the card still reads well if it is renamed later)
        project: { type: mongoose.Schema.Types.ObjectId, ref: "Project" },
        projectName: { type: String, default: "" },
        readAt: { type: Date, default: null }, // when the receiver opened the conversation
    },
    { timestamps: true },
);

messageSchema.index({ pair: 1, _id: -1 }); // a conversation, newest first
messageSchema.index({ to: 1, readAt: 1 }); // unread counts

module.exports = mongoose.model("message", messageSchema);
