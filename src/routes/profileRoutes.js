const express = require("express");
const profileRouter = express.Router();

const { userAuth } = require("../middlewares/auth");
const { validateEditProfileData, applyProfileEdits } = require("../utils/validations");
const { detectImageExtension, saveProfilePhoto, deleteUploadedPhoto } = require("../utils/uploads");
const readImageBody = require("../middlewares/readImageBody");


profileRouter.get("/profile", userAuth, async (req, res) => {
    try {
        // since in the userAuth i have already attached the user to the req object, we dont need to find the user again
        //just get the user from the req object i.e., req.user
        const user = req.user.toObject();
        delete user.password;
        res.send(user)
    } catch (err) {
        console.log(err);
        res.status(500).send("Internal Server Error");
    }
})

profileRouter.patch("/profile/edit", userAuth, async (req, res) => {
    try {
        // check if the user is present
        if (!validateEditProfileData(req)) {
            throw new Error("Invalid edit fields");
        }
        const loggedInUser = req.user;
        const previousPicture = loggedInUser.profilePicture;
        //update the user details
        applyProfileEdits(loggedInUser, req.body);
        await loggedInUser.save();
        // if the photo changed, remove the old uploaded file (if it was one of ours)
        if (previousPicture !== loggedInUser.profilePicture) {
            await deleteUploadedPhoto(previousPicture, loggedInUser._id.toString());
        }
        res.json({
            message: `${loggedInUser.name}, your profile has been updated successfully.`,
            data: loggedInUser,
        });


    } catch (err) {
        res.status(500).send("ERROR: " + err.message);
    }
})


// Upload a profile photo from the user's device.
// The browser sends the raw image bytes as the request body (Content-Type: image/jpeg etc.)
profileRouter.post("/profile/photo", userAuth, readImageBody, async (req, res) => {
    try {
        const ext = detectImageExtension(req.body);
        if (!ext) {
            return res.status(400).json({ error: "That file is not a valid JPG, PNG, GIF or WebP image" });
        }
        const user = req.user;
        const userId = user._id.toString();
        const previousPicture = user.profilePicture;

        const newUrl = await saveProfilePhoto(req, userId, req.body, ext);
        user.profilePicture = newUrl;
        try {
            await user.save();
        } catch (err) {
            await deleteUploadedPhoto(newUrl, userId); // don't leave an orphan file behind
            throw err;
        }
        await deleteUploadedPhoto(previousPicture, userId);

        const data = user.toObject();
        delete data.password;
        res.json({ message: "Profile photo updated", data });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = profileRouter;
