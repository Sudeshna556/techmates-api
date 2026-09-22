const express = require("express");
const { LIMITS } = require("../utils/projectFiles");

// Reads an uploaded zip sent as the raw request body into req.body (a Buffer).
const parser = express.raw({
    type: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
    limit: LIMITS.MAX_ZIP_BYTES,
});

const readZipBody = (req, res, next) => {
    parser(req, res, (err) => {
        if (err) {
            const tooBig = err.type === "entity.too.large";
            return res.status(tooBig ? 413 : 400).json({
                error: tooBig
                    ? `That upload is too large (max ${LIMITS.MAX_ZIP_BYTES / (1024 * 1024)} MB). Dependencies and build folders are left out automatically - try the "Choose folder" option.`
                    : "Could not read the upload",
            });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: "Send the project as a zip (Content-Type: application/zip)" });
        }
        next();
    });
};

module.exports = readZipBody;
