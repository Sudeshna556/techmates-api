// Helpers for image uploads (profile photos and post images). Uses only Node built-ins (no extra packages).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Backend/uploads  (UPLOAD_DIR can override it, e.g. for a persistent disk in production)
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "..", "uploads");
const UPLOAD_URL_PATH = "/uploads";
const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // 2 MB
const FILE_NAME_RE = /^[\w-]+\.(jpg|png|gif|webp)$/;

// `folder` "" = profile photos (Backend/uploads), "posts" = post images (Backend/uploads/posts)
const folderDir = (folder) => (folder ? path.join(UPLOAD_DIR, folder) : UPLOAD_DIR);
const folderUrlPath = (folder) => (folder ? `${UPLOAD_URL_PATH}/${folder}` : UPLOAD_URL_PATH);

// Work out the real image type from the file's first bytes.
// The Content-Type header can be faked, the bytes can't.
function detectImageExtension(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
    const head = buf.toString("ascii", 0, 6);
    if (head === "GIF87a" || head === "GIF89a") return "gif";
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
    return null;
}

// Where the browser can reach the uploads. Set PUBLIC_BASE_URL when deployed
// (e.g. https://api.mysite.com); locally it is built from the request (http://localhost:3000).
function publicBaseUrl(req) {
    return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
}

function uploadUrl(req, filename, folder = "") {
    return `${publicBaseUrl(req)}${folderUrlPath(folder)}/${filename}`;
}

// Write the image to disk and return its public URL. File names start with the owner's id.
async function saveImage(req, ownerId, buf, ext, folder = "") {
    await fs.promises.mkdir(folderDir(folder), { recursive: true });
    const filename = `${ownerId}-${crypto.randomBytes(8).toString("hex")}.${ext}`;
    await fs.promises.writeFile(path.join(folderDir(folder), filename), buf);
    return uploadUrl(req, filename, folder);
}

// If `url` points at an image THIS user uploaded into `folder`, return its file name, otherwise null.
// (The file name must start with the owner's id, so nobody can point at - or delete - someone else's file.)
function ownedUploadFilename(url, ownerId, folder = "") {
    if (typeof url !== "string" || !ownerId) return null;
    let pathname;
    try {
        pathname = new URL(url).pathname;
    } catch {
        return null;
    }
    if (path.posix.dirname(pathname) !== folderUrlPath(folder)) return null;
    const filename = path.posix.basename(pathname); // drops any ../ tricks
    if (!filename.startsWith(`${ownerId}-`) || !FILE_NAME_RE.test(filename)) return null;
    return filename;
}

function uploadExists(filename, folder = "") {
    return fs.existsSync(path.join(folderDir(folder), filename));
}

// Delete an uploaded image if it belongs to this user. Used when a photo/post is replaced or removed
// so old files don't pile up.
async function deleteUploadedImage(url, ownerId, folder = "") {
    const filename = ownedUploadFilename(url, ownerId, folder);
    if (!filename) return;
    try {
        await fs.promises.unlink(path.join(folderDir(folder), filename));
    } catch {
        // already gone - nothing to do
    }
}

// profile-photo shortcuts
const saveProfilePhoto = (req, userId, buf, ext) => saveImage(req, userId, buf, ext);
const deleteUploadedPhoto = (url, ownerId) => deleteUploadedImage(url, ownerId);

module.exports = {
    UPLOAD_DIR,
    MAX_PHOTO_BYTES,
    detectImageExtension,
    uploadUrl,
    saveImage,
    ownedUploadFilename,
    uploadExists,
    deleteUploadedImage,
    saveProfilePhoto,
    deleteUploadedPhoto,
};
