const express = require("express");
const authRouter = express.Router(); // the name can be anything
// router to authenticate the user so i named it as authRouter.
const User = require("../models/userSchema");
const bcrypt = require("bcrypt");
const { validateSignUpUser, validateLoginUser } = require("../utils/validations");

// SameSite=None+Secure is required when the frontend and backend are on different
// domains (e.g. vercel.app talking to onrender.com); localhost dev stays Lax/non-secure.
const authCookieOptions = (extra = {}) => ({
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    secure: process.env.NODE_ENV === "production",
    ...extra,
});




authRouter.post("/signup", async (req, res) => {
    try {
        const { name, email, password } = req.body;
        //validate the user
        validateSignUpUser(req.body);
        // 2. Check uniqueness
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ error: 'user already exists' });
        }

        //hash the plain password entered by user
        const hashedPassword = await bcrypt.hash(password, 10);
        // console.log(hashedPassword);
        //create the user
        const user = new User({
            name,
            email,
            password: hashedPassword
        })
        //save the user
        await user.save();

        const token = await user.getJWT();
        res.cookie("token", token, authCookieOptions({
            expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }));

        res.status(201).json({
            message: "User registered successfully",
            user: {
                _id: user._id,
                name: user.name,
                email: user.email,
            },
        });
    }
    catch (err) {
        // Only log stack trace for unexpected errors, not validation errors
        if (err.message.includes("is required") || err.message.includes("Invalid") || err.message.includes("strong enough")) {
            console.log("Validation Error: " + err.message);
        } else {
            console.error(err);
        }
        res.status(400).send("ERROR: " + err.message)
    }
})

authRouter.post("/login", async (req, res) => {
    try {

        const { email, password } = req.body;
        //1. validate the user
        validateLoginUser(req.body);

        //2. find user
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ error: "User not found" })
        }
        //3.compare the password
        // const isPasswordValid =  await bcrypt.compare("luffy@123",$2b$10$CRiirp6kbuU3g5FNEY0jZ.6OjReyTkq6Jd89n.ITr1PJFr3l6IA3O);
        const isPasswordValid = await user.isValidatePassword(password)
        if (isPasswordValid) {
            //create a JWT token
            const token = await user.getJWT();
            // console.log(token);
            //add the token to the cookie send the token to the client
            res.cookie("token", token, authCookieOptions({
                expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
            })); // 1 day
            return res.json({
                message: "Login successful",
                user: {
                    _id: user._id,
                    name: user.name,
                    email: user.email,
                    profilePicture: user.profilePicture,
                    about: user.about,
                },
            });
        } else {
            return res.status(401).json({ error: "Invalid credentials" })
        }
        // 4. Issue token/session

    } catch (err) {
        console.log(err);
        res.status(500).send("Internal Server Error");
    }
})

authRouter.post("/logout", async (req, res) => {
    try {
        //to logout the user we need to clear the cookie
        // or we can set the token to null and expiry the cookie time to 0 
        res.cookie("token", null, authCookieOptions({
            expires: new Date(Date.now()),
        }));
        return res.send({ message: "Logout successful" })

    } catch (error) {
        console.log(error);
        res.status(500).send("Internal Server Error");
    }
})

module.exports = authRouter;
