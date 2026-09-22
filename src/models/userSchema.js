const mongoose = require("mongoose");
const validator = require("validator");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { isGithubUrl, isLeetcodeUrl } = require("../utils/profileLinks");

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        match: [/^[a-zA-Z\s]+$/, "Name can only contain letters and spaces"]
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        validate(value) {
            if (!validator.isEmail(value)) {
                throw new Error("Invalid email" + value);
            }
        },
    },
    password: {
        type: String,
        required: true,
        minLength: 6,
        maxLength: 100,
        // Strength is checked in validateSignUpUser before hashing.
        // Do not regex-validate the bcrypt hash on save.
    },
    age: {
        type: Number,
        min: 18,
        max: 60
    },
    gender: {
        type: String,
        validate(value) {
            if (!["Male", "Female", "Other"].includes(value)) {
                throw new Error("Invalid gender");
            }
        }
    },
    // optional; shown as a small badge next to the name. Cleared by removing the field (see applyProfileEdits)
    pronouns: {
        type: String,
        validate(value) {
            if (!["she/her", "he/him", "they/them"].includes(value)) {
                throw new Error("Invalid pronouns");
            }
        }
    },
    // optional links shown on the profile (to connected developers). Stored in one canonical form; see utils/profileLinks.js
    contactEmail: {
        type: String,
        trim: true,
        lowercase: true,
        maxLength: 254,
        validate(value) {
            if (!validator.isEmail(value)) {
                throw new Error("Invalid contact email");
            }
        }
    },
    github: {
        type: String,
        validate(value) {
            if (!isGithubUrl(value)) {
                throw new Error("Invalid GitHub link");
            }
        }
    },
    leetcode: {
        type: String,
        validate(value) {
            if (!isLeetcodeUrl(value)) {
                throw new Error("Invalid LeetCode link");
            }
        }
    },
    Skills: { type: [String] },
    address: {
        street: { type: String, trim: true },
        city: { type: String, trim: true },
        state: { type: String, trim: true },
        country: { type: String, trim: true }
    },
    profilePicture: {
        type: String,
        default: "https://cdn-icons-png.flaticon.com/512/149/149071.png",
        validate(value) {
            if (!validator.isURL(value, { require_tld: false })) {
                throw new Error("Invalid URL");
            }
        }

    },
    about: {
        type: String,
        default: "Hi there! I'm a new user on TechMates."
    }

}, { timestamps: true })

//create a schema method for JWT token generation
userSchema.methods.getJWT = async function () {

    const user = this;
    const token = await jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "1d" })
    return token;
}
//create a schema method for password validation
userSchema.methods.isValidatePassword = async function (passwordInputByUser) {
    const user = this;
    const passwordHash = user.password;
    const isPasswordValid = await bcrypt.compare(passwordInputByUser, passwordHash);
    return isPasswordValid;
}
// const User = mongoose.model("User", userSchema);

module.exports = mongoose.model("User", userSchema);
