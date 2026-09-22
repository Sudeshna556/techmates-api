const express = require("express");
const userRouter = express.Router();
const { userAuth } = require("../middlewares/auth")
const ConnectionRequestModel = require("../models/connectionRequest")
const User = require("../models/userSchema");

// get all the pending requests for the logged in user
userRouter.get("/user/received/requests", userAuth, async (req, res) => {
    try {
        //get the loggedin user details
        const loggedInUser = req.user;


        const connectionRequest = await ConnectionRequestModel.find({
            // receiverId: loggedInUser._id
            toUserId: loggedInUser._id,
            status: "interested"
        }).populate("fromUserId", ["name", "profilePicture", "about", "Skills", "pronouns"])
            .sort({ createdAt: -1 });


        res.json({
            message: "data fetched successfully",
            // a request from a user who has since been deleted has nothing to show
            data: connectionRequest.filter((request) => request.fromUserId),
        });

    } catch (error) {

        res.status(500).json({
            message: "error while fetching data",
            error: error.message,
        })

    }
})

//show the list of connected people or friends with
userRouter.get("/my-connections", userAuth, async (req, res) => {
    try {
        //get the loggedinUser
        const loggedInUser = req.user;
        //how would i fetch the people who are connected to me?
        const connectionRequest = await ConnectionRequestModel.find({
            //find the connection request where the status is accepted
            $or: [
                { fromUserId: loggedInUser._id, status: "accepted" },
                { toUserId: loggedInUser._id, status: "accepted" }
            ],
        }).populate("fromUserId", ["name", "profilePicture", "about", "Skills", "pronouns"])
            .populate("toUserId", ["name", "profilePicture", "about", "Skills", "pronouns"])
            .sort({ updatedAt: -1 }); // most recently accepted first

        const data = connectionRequest.filter((request) => request.fromUserId && request.toUserId).map((request) => {
            //if the request is from the logged in user
            if (request.fromUserId._id.toString() === loggedInUser._id.toString()) {
                return request.toUserId;
            }
            //if the request is to the logged in user
            else {
                return request.fromUserId;
            }
        })

        // People you swiped right on who have not answered yet. They show in your dev list as "waiting",
        // but they are NOT connected: they cannot see your projects or open your profile until they say yes.
        const sent = await ConnectionRequestModel.find({ fromUserId: loggedInUser._id, status: "interested" })
            .populate("toUserId", ["name", "profilePicture", "about", "Skills", "pronouns"])
            .sort({ createdAt: -1 });
        const pending = sent.filter((request) => request.toUserId).map((request) => request.toUserId);

        // they have now seen their matches
        await ConnectionRequestModel.updateMany({ fromUserId: loggedInUser._id, status: "accepted", matchSeenByFrom: false }, { $set: { matchSeenByFrom: true } });

        res.json({ data, pending });


    } catch (err) {
        res.status(400).json({
            message: "error while fetching data",
            error: err,
        })
    }
})

// GET /user/:userId -> the public profile of one of your connections (or your own).
// Anyone else answers 404, so this can't be used to browse people you haven't connected with.
userRouter.get("/user/:userId", userAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        const meId = req.user._id.toString();
        if (!/^[0-9a-f]{24}$/i.test(userId)) {
            return res.status(404).json({ error: "Developer not found" });
        }
        if (userId !== meId) {
            const connected = await ConnectionRequestModel.exists({
                status: "accepted",
                $or: [
                    { fromUserId: meId, toUserId: userId },
                    { fromUserId: userId, toUserId: meId },
                ],
            });
            if (!connected) return res.status(404).json({ error: "Developer not found" });
        }
        const user = await User.findById(userId).select("name profilePicture about Skills age gender pronouns contactEmail github leetcode createdAt");
        if (!user) return res.status(404).json({ error: "Developer not found" });
        res.json({ data: user });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: "Could not load this profile" });
    }
})

userRouter.get("/feed", userAuth, async (req, res) => {
    try {
        //cheeck for loggedin user
        const loggedInUser = req.user;
        //pagination
        const page = req.query.page || 1;
        let limit = req.query.limit || 10;
        let skip = (page - 1) * limit;
        //if the user tries to fetch more than 50 users at a time, then return 50 users
        if (limit > 50) {
            limit = 50;
            skip = 0;
        }

        // find the connection req that are sent
        //constraints to be checkend : 1. show all the db users except himself,accepted users and rejected.

        //find the connection requests that are sent snd received by the logged in user
        const connectionRequests = await ConnectionRequestModel.find({
            // either send or received : use $or operator
            $or: [
                { fromUserId: loggedInUser._id },
                { toUserId: loggedInUser._id }
            ],
        }).select("fromUserId toUserId status");

        // People who already swiped right on you stay in your feed (first), so swiping right on them is a match.
        const meId = loggedInUser._id.toString();
        const likedYou = new Set();
        const hideUsersFromFeed = new Set();
        connectionRequests.forEach((request) => {
            const from = request.fromUserId.toString();
            const to = request.toUserId.toString();
            if (to === meId && request.status === "interested") {
                likedYou.add(from);
                return;
            }
            hideUsersFromFeed.add(from);
            hideUsersFromFeed.add(to);
        })
        likedYou.forEach((id) => hideUsersFromFeed.add(id)); // they are added at the front below, not twice

        //find the users who are not connected to the logged in user
        const users = await User.find({
            $and: [
                { _id: { $nin: Array.from(hideUsersFromFeed) } },
                { _id: { $ne: loggedInUser._id } }
            ]
        }).select("name profilePicture about Skills pronouns")
            .skip(skip)
            .limit(limit)
            .lean();

        if (likedYou.size > 0) {
            const admirers = await User.find({ _id: { $in: Array.from(likedYou) } })
                .select("name profilePicture about Skills pronouns")
                .limit(50)
                .lean();
            users.unshift(...admirers.map((user) => ({ ...user, likedYou: true })));
        }

        res.send(users);

    } catch (error) {
        res.status(400).json({
            message: "error while fetching data",
            error: error,
        })
    }
})



module.exports = userRouter;
