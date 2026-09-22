const express = require("express");
const RequestRouter = express.Router();
const { userAuth } = require("../middlewares/auth")
const ConnectionRequestModel = require("../models/connectionRequest");
const User = require("../models/userSchema")


RequestRouter.post("/send/request/:status/:toUserId", userAuth, async (req, res) => {
    try {
        //extract the user
        const toUserId = req.params.toUserId;
        const fromUserId = req.user._id;
        const status = req.params.status;

        const allowedStatus = ["ignored", "interested"];
        if (!allowedStatus.includes(status)) {
            return res.status(400).send({ message: "Invalid status" + " " + status })
        }

        // Fetch the receiver's user details so that i can sent the res message along with the users name
        //b/c toUserId → just an ID string, not a user object.

        //so we need to find the user in the database if toUserId is valid or present in the database otherwise it can sent req to anyone
        //edge case : if toUserId is not valid or not present in the database
        const toUser = await User.findById(toUserId).select("name");
        if (!toUser) {
            return res.status(404).send({ message: "User not found" })
        }

        // is there already a request between these two people (in either direction)?
        const existing = await ConnectionRequestModel.findOne({
            $or: [
                { fromUserId, toUserId },
                { fromUserId: toUserId, toUserId: fromUserId }
            ]
        });
        if (existing) {
            const theyAskedFirst = existing.fromUserId.toString() === toUserId.toString() && existing.status === "interested";
            if (theyAskedFirst && status === "interested") {
                // They swiped right on you earlier and now you swiped right on them: it's a match, both are connected.
                existing.status = "accepted";
                existing.matchSeenByFrom = false; // their bell tells them
                const data = await existing.save();
                return res.json({
                    message: "It's a match! You and " + toUser.name + " are now connected",
                    matched: true,
                    data
                });
            }
            if (theyAskedFirst && status === "ignored") {
                // Skipping someone who swiped right on you turns them down.
                existing.status = "rejected";
                const data = await existing.save();
                return res.json({ message: "Skipped " + toUser.name, matched: false, data });
            }
            if (existing.status === "accepted") {
                return res.status(400).send({ message: "You are already connected with " + toUser.name })
            }
            return res.status(400).send({ message: "You have already sent a request to " + toUser.name })
        }
        //edge case : user can not sent request to himself
        // if (toUserId === fromUserId) {
        //     return res.status(400).send({ message: "You can not sent request to yourself" })
        // }
        //creatie a new connection request instance
        // Swiping right sends interest ("interested"): the person waits in your dev list until they swipe right on you
        // too (or accept), which makes it a match. Swiping left ("ignored") just hides them from your feed.
        const connectionRequest = await ConnectionRequestModel.create({
            fromUserId,
            toUserId,
            status,
        })
        const data = await connectionRequest.save();

        res.json({
            message: req.user.name + " is " + status + " to " + toUser.name,
            matched: false,
            data
        })

    } catch (err) {
        res.status(500).send("ERROR: " + err.message)
    }
})

// review requests : "/request/review/:status/:requestId"

RequestRouter.post("/request/review/:status/:requestId", userAuth, async (req, res) => {
    try {
        //extract the req id from the route params
        const loggedInUser = req.user;
        const { status, requestId } = req.params;

        //check for allowed status
        const allowedStatus = ["accepted", "rejected"];
        if (!allowedStatus.includes(status)) {
            return res.status(400).send({ message: "Invalid status" })
        }

        //check if the req user exists in the db or not

        const connectionRequest = await ConnectionRequestModel.findOne({
            _id: requestId,
            toUserId: loggedInUser._id, //usually, the receiver reviews the request, not the sender
            status: "interested"
        })
        //edge case : if the request is not found
        if (!connectionRequest) {
            return res.status(404).send({ message: "Request not found" })
        }
        connectionRequest.status = status;
        if (status === "accepted") connectionRequest.matchSeenByFrom = false; // the sender's bell tells them it's a match
        const data = await connectionRequest.save();

        res.json({ message: "Connection request " + status, data });

    } catch (err) {
        res.status(500).send("ERROR: " + err.message)

    }
})

// Remove an accepted connection: the developer disappears from each other's My devs, chat and project access
// (both use the same isConnected check), and they will show up again in Discover so a fresh swipe can reconnect them.
RequestRouter.delete("/connections/:userId", userAuth, async (req, res) => {
    try {
        const meId = req.user._id;
        const { userId } = req.params;
        if (!/^[0-9a-f]{24}$/i.test(userId)) {
            return res.status(404).send({ message: "You are not connected with this developer" });
        }
        const removed = await ConnectionRequestModel.findOneAndDelete({
            status: "accepted",
            $or: [
                { fromUserId: meId, toUserId: userId },
                { fromUserId: userId, toUserId: meId },
            ],
        });
        if (!removed) {
            return res.status(404).send({ message: "You are not connected with this developer" });
        }
        const other = await User.findById(userId).select("name");
        res.json({ message: `You unfollowed ${other ? other.name : "this developer"}.` });
    } catch (err) {
        res.status(500).send("ERROR: " + err.message);
    }
});

module.exports = RequestRouter;


