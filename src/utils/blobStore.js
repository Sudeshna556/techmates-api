"use strict";
// Content-addressed file storage: every distinct file is stored ONCE, named by the SHA-256 of
// its contents, as a raw-deflate stream. Versions and projects only hold lists of fingerprints,
// so re-uploading an unchanged file costs nothing, and downloads can copy the stored bytes
// straight into a zip without recompressing them.

const fs = require("fs");
const path = require("path");
const { isSha256 } = require("./projectFiles");

const ROOT = () => process.env.PROJECT_STORAGE_DIR || path.join(__dirname, "..", "..", "storage", "projects");

function blobPath(hash) {
    if (!isSha256(hash)) throw new Error("invalid blob hash");
    return path.join(ROOT(), "blobs", hash.slice(0, 2), hash);
}

async function hasBlob(hash) {
    try {
        await fs.promises.access(blobPath(hash));
        return true;
    } catch {
        return false;
    }
}

/** Stores the data unless that content is already stored. Returns true if it was newly written. */
async function putBlob(hash, deflated) {
    const target = blobPath(hash);
    if (await hasBlob(hash)) return false;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.promises.writeFile(tmp, deflated);
    await fs.promises.rename(tmp, target); // atomic: readers never see half a file
    return true;
}

async function readBlob(hash) {
    return fs.promises.readFile(blobPath(hash));
}

/** Everything on disk: [{hash, ageMs}] plus leftover temp files from interrupted writes. */
async function scanStore() {
    const root = path.join(ROOT(), "blobs");
    const stored = [];
    const tmpFiles = [];
    let shards = [];
    try {
        shards = await fs.promises.readdir(root);
    } catch {
        return { stored, tmpFiles };
    }
    for (const shard of shards) {
        let names = [];
        try {
            names = await fs.promises.readdir(path.join(root, shard));
        } catch {
            continue;
        }
        for (const name of names) {
            const file = path.join(root, shard, name);
            let st;
            try {
                st = await fs.promises.stat(file);
            } catch {
                continue;
            }
            const ageMs = Date.now() - st.mtimeMs;
            if (isSha256(name)) stored.push({ hash: name, ageMs });
            else if (name.endsWith(".tmp")) tmpFiles.push({ file, ageMs });
        }
    }
    return { stored, tmpFiles };
}

/** Milliseconds since the blob was written (Infinity if it does not exist). */
async function blobAgeMs(hash) {
    try {
        const st = await fs.promises.stat(blobPath(hash));
        return Date.now() - st.mtimeMs;
    } catch {
        return Infinity;
    }
}

async function deleteBlob(hash) {
    try {
        await fs.promises.unlink(blobPath(hash));
    } catch (err) {
        if (err.code !== "ENOENT") throw err;
    }
}

module.exports = { blobPath, hasBlob, putBlob, readBlob, blobAgeMs, deleteBlob, scanStore };
