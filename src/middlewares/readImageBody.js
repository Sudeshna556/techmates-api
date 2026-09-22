const express = require("express");
const { MAX_PHOTO_BYTES } = require("../utils/uploads");

// Reads an uploaded image sent as the raw request body (Content-Type: image/jpeg etc.)
// into req.body as a Buffer. Answers with a JSON error if it is missing or too big.
const parser = express.raw({ type: ["image/jpeg", "image/png", "image/gif", "image/webp"], limit: MAX_PHOTO_BYTES });

const readImageBody = (req, res, next) => {
    parser(req, res, (err) => {
        if (err) {
            const tooBig = err.type === "entity.too.large";
            return res.status(tooBig ? 413 : 400).json({ error: tooBig ? "Image is too large (max 2 MB)" : "Could not read the image" });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: "Send the image as image/jpeg, image/png, image/gif or image/webp" });
        }
        next();
    });
};

module.exports = readImageBody;
