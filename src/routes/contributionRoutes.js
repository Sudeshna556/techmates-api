"use strict";
// Working on somebody else's project, with their consent:
//
//   1. a connection ASKS ("what I want to improve, and why")
//   2. the owner APPROVES (or declines, with a reason) - only now may they take a copy
//   3. they work locally, then SEND ONLY THEIR CHANGES with an explanation of what changed and why
//   4. the owner reads the explanation and the line-by-line changes, then MERGES them into a new
//      version, asks for changes, or declines. Nothing reaches the project before that.

const express = require("express");
const zlib = require("zlib");
const { promisify } = require("util");
const contributionRouter = express.Router();

const { userAuth } = require("../middlewares/auth");
const readZipBody = require("../middlewares/readZipBody");
const ProjectVersion = require("../models/projectVersion");
const ProjectContribution = require("../models/projectContribution");
const User = require("../models/userSchema");

const { LIMITS, normalizePath, diffManifests } = require("../utils/projectFiles");
const { ingestZip, ProjectError } = require("../utils/projectIngest");
const { isBinary } = require("../utils/secretScan");
const { diffText } = require("../utils/lineDiff");
const { planMerge } = require("../utils/contributionMerge");
const blobs = require("../utils/blobStore");
const { isId, str, cleanText, OPEN, NOTIFY_AUTHOR, wrap, authorize, userView, logActivity, collectGarbage, commitVersion, parseVersionNumber, getVersion } = require("./projectCommon");

const inflateRaw = promisify(zlib.inflateRaw);

const RULES = {
    MAX_OPEN_PER_PERSON: 3, // requests one person can have going on one project
    TITLE_MIN: 5,
    TITLE_MAX: 100,
    INTENT_MIN: 30,
    INTENT_MAX: 1500,
    EXPLANATION_MIN: 30,
    EXPLANATION_MAX: 2000,
    NOTE_MAX: 500,
    REASON_MIN: 5, // a decline / "please change this" needs a real reason
    MAX_FINDINGS_SHOWN: 50,
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const contributionView = (c, author, { withChanges = false } = {}) => ({
    _id: c._id,
    project: c.project,
    author: userView(author),
    title: c.title,
    intent: c.intent,
    status: c.status === "merging" ? "submitted" : c.status,
    explanation: c.explanation,
    decisionNote: c.decisionNote,
    baseVersion: c.baseVersion ?? null,
    mergedVersion: c.mergedVersion ?? null,
    summary: c.summary,
    createdAt: c.createdAt,
    submittedAt: c.submittedAt ?? null,
    decidedAt: c.decidedAt ?? null,
    ...(withChanges ? { changes: (c.changes || []).map((x) => ({ path: x.path, kind: x.kind, size: x.size ?? null })) } : {}),
});

/** Loads one contribution of this project that the caller may see: the owner sees all, an author only their own. */
async function loadContribution(req, ctx) {
    const { cid } = req.params;
    if (!isId(cid)) throw new ProjectError(404, "Request not found");
    const c = await ProjectContribution.findById(cid);
    if (!c || c.project.toString() !== ctx.project._id.toString()) throw new ProjectError(404, "Request not found");
    const isAuthor = c.author.toString() === req.user._id.toString();
    if (ctx.role !== "owner" && !isAuthor) throw new ProjectError(404, "Request not found");
    return { c, isAuthor };
}

const mustBeAuthor = (isAuthor) => {
    if (!isAuthor) throw new ProjectError(403, "Only the person who made this request can do that");
};

function needText(value, min, max, message) {
    const text = cleanText(value, max + 1);
    if (text.length < min) throw new ProjectError(400, message);
    if (text.length > max) throw new ProjectError(400, `Please keep it under ${max} characters`);
    return text;
}

const TITLE_MESSAGE = `Give it a short title (at least ${RULES.TITLE_MIN} characters), like "Fix the login redirect"`;
const INTENT_MESSAGE = `Explain what you want to improve and why (at least ${RULES.INTENT_MIN} characters), so the owner can decide`;
const EXPLANATION_MESSAGE = `Explain what you changed and why (at least ${RULES.EXPLANATION_MIN} characters) before sending your changes`;

// ---------------------------------------------------------------------------
// asking, listing, reading
// ---------------------------------------------------------------------------

// POST /projects/:id/contributions { title, intent } - "may I work on this?"
contributionRouter.post("/projects/:id/contributions", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req);
    if (ctx.role === "owner") throw new ProjectError(400, "This is your own project - you can just upload a new version");
    const body = req.body || {};
    const title = needText(body.title, RULES.TITLE_MIN, RULES.TITLE_MAX, TITLE_MESSAGE);
    const intent = needText(body.intent, RULES.INTENT_MIN, RULES.INTENT_MAX, INTENT_MESSAGE);
    const open = await ProjectContribution.countDocuments({ project: ctx.project._id, author: req.user._id, status: { $in: OPEN } });
    if (open >= RULES.MAX_OPEN_PER_PERSON) {
        throw new ProjectError(409, `You already have ${RULES.MAX_OPEN_PER_PERSON} requests waiting on this project. Finish or withdraw one first.`);
    }
    const c = await ProjectContribution.create({ project: ctx.project._id, author: req.user._id, title, intent });
    await logActivity(ctx.project, req.user, "ask", { detail: { contribution: c._id, title } });
    res.status(201).json({ contribution: contributionView(c, req.user) });
}));

// GET /projects/:id/contributions -> the owner sees everybody's, anybody else only their own
contributionRouter.get("/projects/:id/contributions", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req);
    const filter = ctx.role === "owner" ? { project: ctx.project._id } : { project: ctx.project._id, author: req.user._id };
    const rows = await ProjectContribution.find(filter).sort({ _id: -1 }).limit(50).populate("author", "name profilePicture").lean();
    if (ctx.role !== "owner") {
        // the author has now seen where each of their requests stands: clear the "the owner replied" notification
        for (const c of rows) {
            if (NOTIFY_AUTHOR.includes(c.status) && c.authorSeen !== c.status) await ProjectContribution.updateOne({ _id: c._id }, { $set: { authorSeen: c.status } });
        }
    }
    res.json({ contributions: rows.map((c) => contributionView(c, c.author)) });
}));

// GET /projects/:id/contributions/:cid -> one request, with the list of files it changes
contributionRouter.get("/projects/:id/contributions/:cid", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req);
    const { c } = await loadContribution(req, ctx);
    const author = await User.findById(c.author).select("name profilePicture");
    res.json({ contribution: contributionView(c, author, { withChanges: true }) });
}));

// ---------------------------------------------------------------------------
// the author: explain, send changes, withdraw
// ---------------------------------------------------------------------------

// PATCH /projects/:id/contributions/:cid { explanation } - what was changed and why (saved before the files go up)
contributionRouter.patch("/projects/:id/contributions/:cid", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req);
    const { c, isAuthor } = await loadContribution(req, ctx);
    mustBeAuthor(isAuthor);
    if (!["approved", "changes-requested"].includes(c.status)) throw new ProjectError(409, "You can only explain your changes once the owner has approved your request");
    c.explanation = needText((req.body || {}).explanation, RULES.EXPLANATION_MIN, RULES.EXPLANATION_MAX, EXPLANATION_MESSAGE);
    await c.save();
    res.json({ contribution: contributionView(c, req.user, { withChanges: true }) });
}));

// POST /projects/:id/contributions/:cid/changes?base=N  body: zip (changed files + manifest, or the whole project)
// `base` = the version their working copy came from. Only what differs from it is kept.
contributionRouter.post("/projects/:id/contributions/:cid/changes", userAuth, readZipBody, wrap(async (req, res) => {
    const ctx = await authorize(req);
    const { c, isAuthor } = await loadContribution(req, ctx);
    mustBeAuthor(isAuthor);
    if (!["approved", "changes-requested"].includes(c.status)) throw new ProjectError(409, "You can only send changes once the owner has approved your request");
    if (c.explanation.length < RULES.EXPLANATION_MIN) throw new ProjectError(400, EXPLANATION_MESSAGE, { code: "EXPLANATION_REQUIRED" });

    const baseNumber = parseVersionNumber(req.query.base) ?? ctx.project.latestVersion;
    let base;
    try {
        base = await getVersion(ctx.project, baseNumber);
    } catch (err) {
        if (err instanceof ProjectError && err.status === 404) throw new ProjectError(404, "That version is no longer available - download the latest version, apply your changes to it and try again");
        throw err;
    }

    const result = ingestZip(req.body, base.files);
    if (result.findings.length) {
        // no "share anyway" here: it is the owner's project, secrets are never pushed into it
        throw new ProjectError(422, "Your changes look like they contain secrets. Remove them before sending.", {
            code: "SECRETS_FOUND",
            findings: result.findings.slice(0, RULES.MAX_FINDINGS_SHOWN),
            totalFindings: result.findings.length,
            report: result.report,
        });
    }
    const diff = diffManifests(base.files, result.files);
    if (diff.added.length + diff.changed.length + diff.removed.length === 0) {
        throw new ProjectError(409, `Nothing differs from v${base.number}. Make your changes first, then send them.`, { report: result.report });
    }

    const baseByPath = new Map(base.files.map((f) => [f.path, f]));
    const nowByPath = new Map(result.files.map((f) => [f.path, f]));
    const changes = [
        ...diff.added.map((p) => ({ kind: "added", ...nowByPath.get(p) })),
        ...diff.changed.map((p) => ({ kind: "changed", ...nowByPath.get(p), baseHash: baseByPath.get(p).hash })),
        ...diff.removed.map((p) => ({ kind: "removed", path: p, baseHash: baseByPath.get(p).hash })),
    ];
    for (const [hash, deflated] of result.newBlobs) await blobs.putBlob(hash, deflated);

    const replaced = c.changes.map((x) => x.hash); // a re-send replaces the earlier changes
    c.changes = changes;
    c.baseVersion = base.number;
    c.summary = { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length };
    c.status = "submitted";
    c.submittedAt = new Date();
    c.decisionNote = "";
    await c.save();
    await collectGarbage(replaced);
    await logActivity(ctx.project, req.user, "submit", { detail: { contribution: c._id, title: c.title, ...c.summary } });
    res.status(201).json({ contribution: contributionView(c, req.user, { withChanges: true }), report: result.report });
}));

// DELETE /projects/:id/contributions/:cid -> the author withdraws their request
contributionRouter.delete("/projects/:id/contributions/:cid", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req);
    const { c, isAuthor } = await loadContribution(req, ctx);
    mustBeAuthor(isAuthor);
    if (!OPEN.includes(c.status) || c.status === "merging") throw new ProjectError(409, "This request is already finished");
    const freed = c.changes.map((x) => x.hash);
    c.status = "withdrawn";
    c.decidedAt = new Date();
    c.changes = [];
    await c.save();
    await collectGarbage(freed);
    await logActivity(ctx.project, req.user, "withdraw", { detail: { contribution: c._id, title: c.title } });
    res.json({ contribution: contributionView(c, req.user) });
}));

// ---------------------------------------------------------------------------
// the owner: read the changes, decide
// ---------------------------------------------------------------------------

// GET /projects/:id/contributions/:cid/diff?path=  -> line-by-line changes of one file (owner and author)
contributionRouter.get("/projects/:id/contributions/:cid/diff", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req);
    const { c } = await loadContribution(req, ctx);
    const path = normalizePath(str(req.query.path));
    const change = path && c.changes.find((x) => x.path === path);
    if (!change) throw new ProjectError(404, "File not found in this request");

    const info = { path, kind: change.kind };
    if ((change.size || 0) > LIMITS.MAX_PREVIEW_BYTES) return res.json({ ...info, tooLarge: true });
    const read = async (hash) => {
        if (!hash) return Buffer.alloc(0);
        try {
            return await inflateRaw(await blobs.readBlob(hash));
        } catch (err) {
            console.log("could not read stored file", hash, err.message);
            throw new ProjectError(500, "This file could not be read");
        }
    };
    const before = await read(change.kind === "added" ? null : change.baseHash);
    const after = await read(change.kind === "removed" ? null : change.hash);
    if (before.length > LIMITS.MAX_PREVIEW_BYTES) return res.json({ ...info, tooLarge: true });
    if (isBinary(before) || isBinary(after)) return res.json({ ...info, binary: true });
    res.json({ ...info, ...diffText(before.toString("utf8"), after.toString("utf8")) });
}));

const ACTIONS = {
    // action: [from statuses, new status, needs a written reason]
    approve: [["asking"], "approved", false],
    decline: [["asking", "approved", "submitted", "changes-requested"], "declined", true],
    "request-changes": [["submitted"], "changes-requested", true],
};

// POST /projects/:id/contributions/:cid/decision { action: "approve"|"decline"|"request-changes"|"merge", note }
contributionRouter.post("/projects/:id/contributions/:cid/decision", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req, { owner: true });
    const { c } = await loadContribution(req, ctx);
    const body = req.body || {};
    const action = str(body.action);
    const note = cleanText(body.note, RULES.NOTE_MAX + 1);
    if (note.length > RULES.NOTE_MAX) throw new ProjectError(400, `Please keep your note under ${RULES.NOTE_MAX} characters`);
    const author = await User.findById(c.author).select("name profilePicture");

    if (action === "merge") {
        if (c.status !== "submitted") throw new ProjectError(409, "There are no changes waiting to be merged");
        // claim it, so a double click (or two tabs) cannot merge it twice
        const claim = await ProjectContribution.updateOne({ _id: c._id, status: "submitted" }, { $set: { status: "merging" } });
        if (!claim.matchedCount) throw new ProjectError(409, "These changes are already being merged");
        try {
            const latest = await getVersion(ctx.project, undefined);
            const plan = planMerge(latest.files, c.changes);
            if (!plan.ok) {
                throw new ProjectError(409, "The project has changed since this person started, and some of the same files were touched. Ask them to update their work on the latest version and send it again.", {
                    code: "CONFLICT",
                    conflicts: plan.conflicts.slice(0, 20),
                });
            }
            const bytes = plan.files.reduce((n, f) => n + f.size, 0);
            if (plan.files.length > LIMITS.MAX_FILES || bytes > LIMITS.MAX_PROJECT_BYTES) throw new ProjectError(413, "Merging this would make the project larger than the size limits allow");
            const diff = diffManifests(latest.files, plan.files);
            const version = await commitVersion(
                ctx.project,
                req.user,
                { files: plan.files, newBlobs: new Map(), stats: { fileCount: plan.files.length, bytes }, summary: { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length } },
                `${c.title} (by ${author ? author.name : "a dev"})`.slice(0, 200),
                0,
                { contributedBy: c.author, contribution: c._id },
            );
            c.status = "merged";
            c.mergedVersion = version.number;
            c.decidedAt = new Date();
            c.decisionNote = note;
            await c.save();
            await logActivity(ctx.project, req.user, "merge", { target: c.author, detail: { contribution: c._id, title: c.title, version: version.number, ...c.summary } });
            return res.json({ contribution: contributionView(c, author, { withChanges: true }), version: { number: version.number } });
        } catch (err) {
            await ProjectContribution.updateOne({ _id: c._id, status: "merging" }, { $set: { status: "submitted" } }); // nothing was merged
            throw err;
        }
    }

    const rule = ACTIONS[action];
    if (!rule) throw new ProjectError(400, "Choose approve, decline, request changes or merge");
    const [from, to, needsReason] = rule;
    if (!from.includes(c.status)) throw new ProjectError(409, "This request has already moved on");
    if (needsReason && note.length < RULES.REASON_MIN) {
        throw new ProjectError(400, action === "decline" ? "Tell them why - a short reason helps them" : "Tell them what to change");
    }
    const freed = to === "declined" ? c.changes.map((x) => x.hash) : [];
    c.status = to;
    c.decisionNote = note;
    c.decidedAt = new Date();
    if (to === "declined") c.changes = [];
    await c.save();
    if (freed.length) await collectGarbage(freed);
    await logActivity(ctx.project, req.user, action === "approve" ? "approve" : action === "decline" ? "decline" : "request-changes", { target: c.author, detail: { contribution: c._id, title: c.title } });
    res.json({ contribution: contributionView(c, author, { withChanges: true }) });
}));

module.exports = contributionRouter;
