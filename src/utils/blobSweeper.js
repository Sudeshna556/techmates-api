"use strict";
// Housekeeping for the file store. Deleting a version frees its files right away when it can, but
// never touches very young files (an upload may be about to reuse them) - so a sweep now and then
// removes anything no version refers to any more, plus temp files left by interrupted uploads.

const fs = require("fs");
const blobs = require("./blobStore");

const GRACE_MS = 10 * 60 * 1000;
const STALE_TMP_MS = 60 * 60 * 1000;

// `isUsed` is async (hash) => boolean. A bare model is accepted too and means "some version lists this file".
const asCheck = (isUsed) => (typeof isUsed === "function" ? isUsed : (hash) => isUsed.exists({ "files.hash": hash }));

/**
 * @param isUsed  async (hash) => is any version or pending change still using this stored file?
 * @returns {{checked, deleted, tmpDeleted}}
 */
async function sweepOrphanBlobs(isUsed, { graceMs = GRACE_MS } = {}) {
    const used = asCheck(isUsed);
    const { stored, tmpFiles } = await blobs.scanStore();
    let deleted = 0;
    let tmpDeleted = 0;
    for (const { hash, ageMs } of stored) {
        if (ageMs < graceMs) continue;
        if (await used(hash)) continue;
        await blobs.deleteBlob(hash);
        deleted++;
    }
    for (const { file, ageMs } of tmpFiles) {
        if (ageMs < STALE_TMP_MS) continue;
        await fs.promises.unlink(file).catch(() => {});
        tmpDeleted++;
    }
    return { checked: stored.length, deleted, tmpDeleted };
}

/** Sweeps a minute after start-up, then every 6 hours. Never keeps the process alive, never throws. */
function startBlobSweeper(isUsed) {
    const run = () =>
        sweepOrphanBlobs(isUsed)
            .then((r) => {
                if (r.deleted || r.tmpDeleted) console.log(`project storage cleanup: removed ${r.deleted} unused files, ${r.tmpDeleted} temp files`);
            })
            .catch((err) => console.log("project storage cleanup failed:", err.message));
    setTimeout(run, 60 * 1000).unref();
    setInterval(run, 6 * 60 * 60 * 1000).unref();
}

module.exports = { sweepOrphanBlobs, startBlobSweeper };
