const validations = require("validator");
const { githubUrl, leetcodeUrl } = require("./profileLinks");

const validateSignUpUser = (req) => {
    const { name, email, password } = req;

    if (!name) {
        throw new Error("Name is required");
    }
    else if (!validations.isEmail(email)) {
        throw new Error("Invalid email!");
    }
    else if (!validations.isStrongPassword(password)) {
        throw new Error("Password is not strong enough! It must be at least 8 characters long and contain at least 1 lowercase letter, 1 uppercase letter, 1 number, and 1 symbol.");
    }
}

//validation for login user
const validateLoginUser = (req) => {
    const { email, password } = req;
    if (!validations.isEmail(email)) {
        throw new Error("Invalid email!");
    }
    else if (!validations.isStrongPassword(password)) {
        throw new Error("Password is not strong enough! It must be at least 8 characters long and contain at least 1 lowercase letter, 1 uppercase letter, 1 number, and 1 symbol.");
    }
}

const validateEditProfileData = (req) => {
    const allowedEditFields = [
        "name",
        "email",
        "password",
        "profilePicture",
        "about",
        "age",
        "gender",
        "pronouns",
        "contactEmail",
        "github",
        "leetcode",
        "Skills"
    ];

    const isEditAllowed = Object.keys(req.body).every((field) => allowedEditFields.includes(field));
    return isEditAllowed;

}


// Copies the edited fields onto the user. Gender, pronouns, contact email and the two profile links are optional:
// sending "" (or null) removes them, because an empty string is not a valid value and the schema would refuse it.
// GitHub / LeetCode accept a username or a link and are stored as one canonical link (or refused).
const CLEARABLE = ["gender", "pronouns", "contactEmail", "github", "leetcode"];
const LINKS = { github: [githubUrl, "GitHub"], leetcode: [leetcodeUrl, "LeetCode"] };
const applyProfileEdits = (user, body) => {
    Object.keys(body).forEach((key) => {
        let value = body[key];
        if (LINKS[key]) {
            const [normalise, site] = LINKS[key];
            const link = normalise(value);
            if (link === null) throw new Error(`That is not a valid ${site} profile link. Use ${site === "GitHub" ? "github.com/username" : "leetcode.com/u/username"} or just your username.`);
            value = link || undefined;
        } else if (key === "contactEmail" && typeof value === "string") {
            value = value.trim() || undefined;
        } else if (CLEARABLE.includes(key) && (value === "" || value === null)) {
            value = undefined;
        }
        user[key] = value;
    });
    return user;
};

module.exports = {
    validateSignUpUser,
    validateLoginUser,
    validateEditProfileData,
    applyProfileEdits
};
