"use strict";
// Turns an uploaded zip into a project version's file list - no database, no HTTP.
//
//  full mode : the zip holds every file (someone zipped their folder by hand).
//  delta mode: the zip also holds ".techmates/manifest.json" listing every file of the new version,
//              and only carries the files that CHANGED. Everything else is reused from the
//              previous version (matched by fingerprint), so a small edit uploads almost nothing.

const crypto = require("crypto");
const { readZip, extractEntry, ZipError } = require("./zipfile");
const { scanFile } = require("./secretScan");
const {
    LIMITS,
    MANIFEST_PATH,
    normalizePath,
    ignoredBy,
    secretFileReason,
    diffManifests,
    isSha256,
} = require("./projectFiles");

class ProjectError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.name = "ProjectError";
        this.status = status;
        this.extra = extra;
    }
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const MB = 1024 * 1024;

// zips made by "compress folder" wrap everything in one top-level folder: drop it
function commonRoot(names) {
    if (names.length === 0) return "";
    const first = names[0].split("/")[0];
    if (!names.every((n) => n.includes("/") && n.split("/")[0] === first)) return "";
    return `${first}/`;
}

/**
 * @param buf       the zip
 * @param previous  the previous version's files [{path, hash, size, csize, crc}] or null
 * @param opts      { allowSecrets }
 * @returns {{ files, newBlobs, findings, report, stats, summary, delta }}
 *   files    : the new version's file list, sorted by path
 *   newBlobs : Map(hash -> raw-deflate Buffer) for content that came in with this upload
 *   findings : suspected secrets [{path, line, kind, preview}] (the caller decides what to do)
 *   report   : what was left out and why
 */
function ingestZip(buf, previous, opts = {}) {
    let entries;
    try {
        entries = readZip(buf);
    } catch (err) {
        if (err instanceof ZipError) throw new ProjectError(400, err.message);
        throw err;
    }

    const report = { skipped: [], excluded: [], tooLarge: [], unsafe: 0 };
    const skippedCounts = new Map();
    const skip = (label) => skippedCounts.set(label, (skippedCounts.get(label) || 0) + 1);

    // --- optional manifest (delta mode) ---
    let manifest = null;
    const manifestEntry = entries.find((e) => e.name === MANIFEST_PATH);
    if (manifestEntry) {
        if (manifestEntry.size > MB) throw new ProjectError(400, "The upload's file list is too large");
        try {
            const { content } = extractEntry(buf, manifestEntry);
            manifest = JSON.parse(content.toString("utf8"));
        } catch {
            throw new ProjectError(400, "The upload's file list is damaged");
        }
        if (!manifest || !Array.isArray(manifest.files)) throw new ProjectError(400, "The upload's file list is damaged");
        if (!previous) throw new ProjectError(400, "There is no previous version to build on");
    }

    // --- decide which zip entries are candidates ---
    const fileEntries = entries.filter((e) => !e.isDir && !e.isSymlink && e.name !== MANIFEST_PATH);
    const root = manifest ? "" : commonRoot(fileEntries.filter((e) => !e.name.startsWith("__MACOSX/")).map((e) => e.name.replace(/\\/g, "/")));

    const candidates = new Map(); // path -> entry
    for (const entry of fileEntries) {
        let name = entry.name.replace(/\\/g, "/");
        if (root && name.startsWith(root)) name = name.slice(root.length);
        const path = normalizePath(name);
        if (!path) {
            report.unsafe++;
            continue;
        }
        const ignored = ignoredBy(path);
        if (ignored) {
            skip(ignored);
            continue;
        }
        const secretName = secretFileReason(path);
        if (secretName) {
            report.excluded.push({ path, reason: secretName });
            continue;
        }
        if (entry.size > LIMITS.MAX_FILE_BYTES) {
            report.tooLarge.push(path);
            continue;
        }
        candidates.set(path, entry); // a later duplicate wins, like unzip
    }

    // --- read the content we were sent ---
    const incoming = new Map(); // path -> {hash, size, csize, crc, deflated}
    const findings = [];
    let declaredBytes = 0;
    for (const [path, entry] of candidates) {
        declaredBytes += entry.size;
        if (declaredBytes > LIMITS.MAX_PROJECT_BYTES) {
            throw new ProjectError(413, `The project is too large (max ${LIMITS.MAX_PROJECT_BYTES / MB} MB of source files). Dependencies and build folders are left out automatically.`);
        }
        let extracted;
        try {
            extracted = extractEntry(buf, entry);
        } catch (err) {
            if (err instanceof ZipError) throw new ProjectError(400, err.message);
            throw err;
        }
        findings.push(...scanFile(path, extracted.content));
        incoming.set(path, { hash: sha256(extracted.content), size: entry.size, csize: extracted.deflated.length, crc: entry.crc, deflated: extracted.deflated });
    }

    // --- assemble the new version's file list ---
    const files = [];
    const newBlobs = new Map();
    if (manifest) {
        if (manifest.files.length > LIMITS.MAX_FILES) throw new ProjectError(413, `Too many files (max ${LIMITS.MAX_FILES})`);
        const known = new Map((previous || []).map((f) => [f.hash, f]));
        const seen = new Set();
        for (const item of manifest.files) {
            const path = normalizePath(item?.path);
            if (!path || !isSha256(item?.hash) || ignoredBy(path) || secretFileReason(path)) {
                throw new ProjectError(400, "The upload's file list is invalid");
            }
            if (seen.has(path)) throw new ProjectError(400, "The upload's file list is invalid");
            seen.add(path);
            const sent = incoming.get(path);
            if (sent) {
                if (sent.hash !== item.hash) throw new ProjectError(400, `"${path}" does not match its fingerprint - please try again`);
                files.push({ path, hash: sent.hash, size: sent.size, csize: sent.csize, crc: sent.crc });
                if (!known.has(sent.hash)) newBlobs.set(sent.hash, sent.deflated);
            } else {
                const reused = known.get(item.hash);
                if (!reused) throw new ProjectError(400, `The upload is missing the content of "${path}"`);
                files.push({ path, hash: reused.hash, size: reused.size, csize: reused.csize, crc: reused.crc });
            }
        }
    } else {
        for (const [path, sent] of incoming) {
            files.push({ path, hash: sent.hash, size: sent.size, csize: sent.csize, crc: sent.crc });
            newBlobs.set(sent.hash, sent.deflated);
        }
    }

    if (files.length === 0) {
        throw new ProjectError(400, "There are no files to share - the upload only contained files that are left out automatically", { report: finishReport(report, skippedCounts) });
    }
    if (files.length > LIMITS.MAX_FILES) throw new ProjectError(413, `Too many files (max ${LIMITS.MAX_FILES})`);
    const bytes = files.reduce((n, f) => n + f.size, 0);
    if (bytes > LIMITS.MAX_PROJECT_BYTES) throw new ProjectError(413, `The project is too large (max ${LIMITS.MAX_PROJECT_BYTES / MB} MB of source files)`);

    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const diff = diffManifests(previous, files);

    return {
        files,
        newBlobs,
        findings,
        report: finishReport(report, skippedCounts),
        stats: { fileCount: files.length, bytes },
        summary: { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length },
        delta: Boolean(manifest),
    };
}

function finishReport(report, skippedCounts) {
    return {
        skipped: [...skippedCounts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
        excluded: report.excluded,
        tooLarge: report.tooLarge,
        unsafe: report.unsafe,
    };
}

module.exports = { ingestZip, ProjectError, sha256 };
