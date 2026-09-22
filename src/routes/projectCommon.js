"use strict";
// Shared by the project routes and the contribution routes: who may do what, the small view
// shapes, activity logging, storing a new version, and cleaning up stored files.

const Project = require("../models/project");
const ProjectVersion = require("../models/projectVersion");
const ProjectAccess = require("../models/projectAccess");
const ProjectActivity = require("../models/projectActivity");
const ProjectContribution = require("../models/projectContribution");
const ConnectionRequest = require("../models/connectionRequest");

const { LIMITS } = require("../utils/projectFiles");
const { ProjectError } = require("../utils/projectIngest");
const blobs = require("../utils/blobStore");

const isId = (v) => typeof v === "string" && /^[0-9a-f]{24}$/i.test(v);
const str = (v) => (typeof v === "string" ? v : "");
const cleanText = (v, max) => str(v).trim().slice(0, max);
const BLOB_GRACE_MS = 10 * 60 * 1000; // never delete a stored file younger than this (an upload may be about to use it)

// contribution states
const OPEN = ["asking", "approved", "submitted", "merging", "changes-requested"]; // still going
const CAN_WORK = ["approved", "submitted", "merging", "changes-requested"]; // the owner said yes: may take a copy
const NOTIFY_AUTHOR = ["approved", "changes-requested", "declined", "merged"]; // replies the author is told about (until they have looked)

// wraps a handler: ProjectError -> its status + message, anything else -> 500 (logged)
const wrap = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        if (err instanceof ProjectError) {
            if (!res.headersSent) res.status(err.status).json({ error: err.message, ...err.extra });
            return;
        }
        console.log(err);
        if (res.headersSent) return res.destroy();
        res.status(500).json({ error: "Something went wrong. Please try again." });
    }
};

// ---------------------------------------------------------------------------
// who is connected with whom
// ---------------------------------------------------------------------------

async function isConnected(a, b) {
    return Boolean(
        await ConnectionRequest.exists({
            status: "accepted",
            $or: [
                { fromUserId: a, toUserId: b },
                { fromUserId: b, toUserId: a },
            ],
        }),
    );
}

/** Ids of everybody `me` is connected with (accepted, in either direction). */
async function friendIds(me) {
    const rows = await ConnectionRequest.find({ status: "accepted", $or: [{ fromUserId: me }, { toUserId: me }] }).select("fromUserId toUserId").lean();
    return rows.map((r) => (r.fromUserId.toString() === me.toString() ? r.toUserId : r.fromUserId));
}

// ---------------------------------------------------------------------------
// who may do what
// ---------------------------------------------------------------------------

/**
 * Who is asking and what may they do?
 *  owner  -> everything
 *  a connection of the owner (not blocked, project not private) -> look at everything; take a copy
 *            only when the owner allows it (open downloads, or they approved this person's request)
 *  anyone else -> 404 (we do not even confirm the project exists)
 */
async function authorize(req, { owner = false } = {}) {
    const { id } = req.params;
    if (!isId(id)) throw new ProjectError(404, "Project not found");
    const project = await Project.findById(id);
    if (!project) throw new ProjectError(404, "Project not found");
    const me = req.user._id;
    if (project.owner.toString() === me.toString()) return { project, role: "owner", canFetch: true, access: null };

    if (project.visibility === "private") throw new ProjectError(404, "Project not found");
    const access = await ProjectAccess.findOne({ project: project._id, user: me });
    if (access && access.status === "blocked") throw new ProjectError(404, "Project not found");
    if (!(await isConnected(project.owner, me))) throw new ProjectError(404, "Project not found");
    if (owner) throw new ProjectError(403, "Only the project owner can do that");

    const canFetch = project.openDownloads === true || Boolean(await ProjectContribution.exists({ project: project._id, author: me, status: { $in: CAN_WORK } }));
    return { project, role: "member", canFetch, access };
}

const NO_DOWNLOAD = "Ask the owner if you can work on this project first - downloading needs their approval.";

// ---------------------------------------------------------------------------
// view shapes
// ---------------------------------------------------------------------------

// a message as one short line for lists and notifications: code blocks become "[code]"
const collapse = (text) => str(text).replace(/`{3,}[\s\S]*?`{3,}/g, "[code]").replace(/\s+/g, " ").trim();
// cut by visible characters, not by UTF-16 units, so an emoji at the cut is dropped whole instead of left as a broken half
const graphemes = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const oneLine = (text, max) => {
    const line = collapse(text);
    const chars = graphemes ? Array.from(graphemes.segment(line), (part) => part.segment) : Array.from(line);
    return chars.slice(0, max).join("");
};

const userView = (u) => (u && u._id ? { _id: u._id, name: u.name, profilePicture: u.profilePicture } : null);

const projectView = (p) => ({
    _id: p._id,
    name: p.name,
    description: p.description,
    visibility: p.visibility === "private" ? "private" : "friends",
    openDownloads: p.openDownloads === true,
    latestVersion: p.latestVersion,
    fileCount: p.fileCount,
    bytes: p.bytes,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
});

const versionView = (v) => ({
    number: v.number,
    message: v.message,
    createdAt: v.createdAt,
    fileCount: v.fileCount,
    bytes: v.bytes,
    summary: v.summary,
    contributor: userView(v.contributedBy),
});

// ---------------------------------------------------------------------------
// activity, versions, stored files
// ---------------------------------------------------------------------------

async function logActivity(project, actor, type, extra = {}) {
    try {
        await ProjectActivity.create({ project: project._id, actor: actor._id, type, ...extra });
    } catch (err) {
        console.log("could not write project activity", err.message); // the log must never break the action itself
    }
}

/** Is this stored file still needed - by a version, or by a change somebody has proposed? */
async function isBlobUsed(hash) {
    if (await ProjectVersion.exists({ "files.hash": hash })) return true;
    return Boolean(await ProjectContribution.exists({ "changes.hash": hash }));
}

// delete stored files that nothing refers to any more
async function collectGarbage(hashes) {
    for (const hash of new Set(hashes.filter(Boolean))) {
        try {
            if (await isBlobUsed(hash)) continue;
            if ((await blobs.blobAgeMs(hash)) < BLOB_GRACE_MS) continue;
            await blobs.deleteBlob(hash);
        } catch (err) {
            console.log("blob cleanup failed", err.message);
        }
    }
}

// keep the newest MAX_VERSIONS versions
async function pruneOldVersions(project, latestNumber) {
    const cutoff = latestNumber - LIMITS.MAX_VERSIONS;
    if (cutoff < 1) return;
    const old = await ProjectVersion.find({ project: project._id, number: { $lte: cutoff } }).select("files.hash").lean();
    if (old.length === 0) return;
    await ProjectVersion.deleteMany({ project: project._id, number: { $lte: cutoff } });
    await collectGarbage(old.flatMap((v) => v.files.map((f) => f.hash)));
}

/**
 * Stores the new content, then points a new version at it.
 * @param extra  { contributedBy, contribution } when the owner merged somebody's changes
 */
async function commitVersion(project, user, result, message, overrides, extra = {}) {
    for (const [hash, deflated] of result.newBlobs) await blobs.putBlob(hash, deflated);
    const bumped = await Project.findByIdAndUpdate(project._id, { $inc: { versionSeq: 1 } }, { new: true });
    const number = bumped.versionSeq;
    const version = await ProjectVersion.create({
        project: project._id,
        number,
        message,
        files: result.files,
        fileCount: result.stats.fileCount,
        bytes: result.stats.bytes,
        summary: result.summary,
        overrides,
        createdBy: user._id,
        ...extra,
    });
    // only ever move "latest" forward, even if two uploads finish out of order
    await Project.updateOne({ _id: project._id, latestVersion: { $lt: number } }, { $set: { latestVersion: number, fileCount: result.stats.fileCount, bytes: result.stats.bytes } });
    await pruneOldVersions(project, number);
    return version;
}

function parseVersionNumber(value) {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !/^\d{1,6}$/.test(value) || Number(value) < 1) throw new ProjectError(400, "Invalid version");
    return Number(value);
}

async function getVersion(project, requested) {
    const number = requested ?? project.latestVersion;
    const version = await ProjectVersion.findOne({ project: project._id, number }).lean();
    if (!version) throw new ProjectError(404, "Version not found");
    return version;
}

/** Remembers which version a person last downloaded (their baseline for "only what changed"). */
async function recordFetch(project, userId, versionNumber) {
    const existing = await ProjectAccess.findOne({ project: project._id, user: userId });
    if (existing) {
        existing.lastFetchedVersion = versionNumber;
        await existing.save();
        return;
    }
    try {
        await ProjectAccess.create({ project: project._id, user: userId, lastFetchedVersion: versionNumber });
    } catch (err) {
        if (err.code !== 11000) throw err;
        await ProjectAccess.updateOne({ project: project._id, user: userId }, { $set: { lastFetchedVersion: versionNumber } }); // created a moment ago by another request
    }
}

module.exports = {
    isId,
    str,
    cleanText,
    OPEN,
    CAN_WORK,
    NOTIFY_AUTHOR,
    wrap,
    isConnected,
    friendIds,
    authorize,
    NO_DOWNLOAD,
    userView,
    oneLine,
    projectView,
    versionView,
    logActivity,
    isBlobUsed,
    collectGarbage,
    commitVersion,
    parseVersionNumber,
    getVersion,
    recordFetch,
};
