const express = require("express");
const zlib = require("zlib");
const { promisify } = require("util");
const projectRouter = express.Router();

const { userAuth } = require("../middlewares/auth");
const readZipBody = require("../middlewares/readZipBody");
const Project = require("../models/project");
const ProjectVersion = require("../models/projectVersion");
const ProjectAccess = require("../models/projectAccess");
const ProjectActivity = require("../models/projectActivity");
const ProjectContribution = require("../models/projectContribution");
const ConnectionRequest = require("../models/connectionRequest");
const Message = require("../models/message");
const User = require("../models/userSchema");

const { LIMITS, normalizePath, diffManifests } = require("../utils/projectFiles");
const { ingestZip, ProjectError } = require("../utils/projectIngest");
const { entryFromBuffer, planZip, streamZip } = require("../utils/zipfile");
const { isBinary } = require("../utils/secretScan");
const blobs = require("../utils/blobStore");
const {
    isId, str, cleanText, OPEN, CAN_WORK, NOTIFY_AUTHOR, wrap, isConnected, friendIds, authorize, NO_DOWNLOAD, userView, oneLine, projectView, versionView,
    logActivity, collectGarbage, commitVersion, parseVersionNumber, getVersion, recordFetch,
} = require("./projectCommon");

const inflateRaw = promisify(zlib.inflateRaw);
const MAX_FINDINGS_SHOWN = 50;
const VIEW_LOG_WINDOW_MS = 10 * 60 * 1000;

function checkSecrets(result, req) {
    if (result.findings.length === 0) return 0;
    if (req.query.allowSecrets === "1") return result.findings.length; // the owner chose to share anyway (recorded in the log)
    throw new ProjectError(422, "This project looks like it contains secrets. Remove them (and change those passwords / keys) before sharing.", {
        code: "SECRETS_FOUND",
        findings: result.findings.slice(0, MAX_FINDINGS_SHOWN),
        totalFindings: result.findings.length,
        report: result.report,
    });
}

// ---------------------------------------------------------------------------
// projects: list / create / details / edit / delete
// ---------------------------------------------------------------------------

// GET /project-notifications -> what needs the person's attention, for the bell in the header:
//   waiting: requests (and changes sent back) on MY projects that I have not decided yet,
//            and people who swiped right on me that I have not answered
//   updates: replies to MY requests on other people's projects that I have not looked at yet,
//            and people I swiped right on who swiped back (a match) that I have not looked at yet
const LIST_MAX = 20;

projectRouter.get("/project-notifications", userAuth, wrap(async (req, res) => {
    const me = req.user._id;

    const mine = await Project.find({ owner: me }).select("name").lean();
    const nameOf = new Map(mine.map((p) => [p._id.toString(), p.name]));
    const waitingRows = mine.length
        ? await ProjectContribution.find({ project: { $in: mine.map((p) => p._id) }, status: { $in: ["asking", "submitted"] } })
              .sort({ _id: -1 })
              .limit(LIST_MAX)
              .populate("author", "name profilePicture")
              .lean()
        : [];
    const waiting = waitingRows
        .filter((c) => c.author)
        .map((c) => ({
            id: c._id,
            projectId: c.project,
            projectName: nameOf.get(c.project.toString()) || "your project",
            title: c.title,
            kind: c.status === "submitted" ? "submitted" : "ask",
            person: userView(c.author),
            at: c.status === "submitted" ? c.submittedAt || c.createdAt : c.createdAt,
        }));

    const replies = await ProjectContribution.find({ author: me, status: { $in: NOTIFY_AUTHOR } }).sort({ _id: -1 }).limit(50).lean();
    const unseen = replies.filter((c) => c.authorSeen !== c.status);
    let updates = [];
    if (unseen.length) {
        const projectIds = [...new Set(unseen.map((c) => c.project.toString()))];
        const projects = await Project.find({ _id: { $in: projectIds } }).populate("owner", "name profilePicture").lean();
        const byId = new Map(projects.map((p) => [p._id.toString(), p]));
        const blocked = new Set((await ProjectAccess.find({ user: me, project: { $in: projectIds }, status: "blocked" }).select("project").lean()).map((a) => a.project.toString()));
        const friends = new Set((await friendIds(me)).map((f) => f.toString()));
        updates = unseen
            .filter((c) => {
                const p = byId.get(c.project.toString());
                return p && p.owner && p.visibility !== "private" && !blocked.has(p._id.toString()) && friends.has(p.owner._id.toString());
            })
            .slice(0, LIST_MAX)
            .map((c) => {
                const p = byId.get(c.project.toString());
                return { id: c._id, projectId: p._id, projectName: p.name, title: c.title, status: c.status, person: userView(p.owner), at: c.decidedAt || c.updatedAt || c.createdAt };
            });
    }
    // connections: someone swiped right on me and is waiting for my answer
    const admirers = await ConnectionRequest.find({ toUserId: me, status: "interested" }).sort({ createdAt: -1 }).limit(LIST_MAX).populate("fromUserId", "name profilePicture").lean();
    for (const r of admirers) {
        if (r.fromUserId) waiting.push({ id: r._id, kind: "connect", person: userView(r.fromUserId), at: r.createdAt });
    }
    // connections: someone I swiped right on swiped back
    const matches = await ConnectionRequest.find({ fromUserId: me, status: "accepted", matchSeenByFrom: false }).sort({ updatedAt: -1 }).limit(LIST_MAX).populate("toUserId", "name profilePicture").lean();
    for (const r of matches) {
        if (r.toUserId) updates.push({ id: r._id, status: "matched", person: userView(r.toUserId), at: r.updatedAt || r.createdAt });
    }
    // chat: unread messages, one line per person (and the total, for the Chats tab)
    let unreadMessages = 0;
    const unreadRows = await Message.find({ to: me, readAt: null }).sort({ _id: -1 }).limit(200).lean();
    if (unreadRows.length) {
        const friends = new Set((await friendIds(me)).map((f) => f.toString()));
        const bySender = new Map();
        for (const m of unreadRows) {
            const key = m.from.toString();
            if (!friends.has(key)) continue;
            unreadMessages += 1;
            if (!bySender.has(key)) bySender.set(key, { count: 0, last: m }); // newest first, so the first one seen is the last message
            bySender.get(key).count += 1;
        }
        const senders = bySender.size ? await User.find({ _id: { $in: [...bySender.keys()] } }).select("name profilePicture").lean() : [];
        for (const person of senders.slice(0, LIST_MAX)) {
            const { count, last } = bySender.get(person._id.toString());
            updates.push({ id: `msg-${person._id}`, status: "message", count, preview: last.text ? oneLine(last.text, 80) : last.projectName ? `Shared ${last.projectName}` : "", person: userView(person), at: last.createdAt });
        }
    }
    const newest = (a, b) => new Date(b.at) - new Date(a.at);
    waiting.sort(newest);
    updates.sort(newest);
    res.json({ count: waiting.length + updates.length, waiting, updates, unreadMessages });
}));

// GET /projects -> { mine, shared }   shared = projects of the people you are connected with
projectRouter.get("/projects", userAuth, wrap(async (req, res) => {
    const me = req.user._id;
    const mine = await Project.find({ owner: me }).sort({ updatedAt: -1 }).lean();
    const waiting = await Promise.all(mine.map((p) => ProjectContribution.countDocuments({ project: p._id, status: { $in: ["asking", "submitted"] } })));

    const friends = await friendIds(me);
    const theirs = friends.length ? await Project.find({ owner: { $in: friends }, visibility: { $ne: "private" } }).sort({ updatedAt: -1 }).populate("owner", "name profilePicture").lean() : [];
    const ids = theirs.map((p) => p._id);
    const records = ids.length ? await ProjectAccess.find({ user: me, project: { $in: ids } }).lean() : [];
    const record = new Map(records.map((r) => [r.project.toString(), r]));
    const myOpen = ids.length ? await ProjectContribution.find({ author: me, project: { $in: ids }, status: { $in: OPEN } }).sort({ _id: -1 }).lean() : [];

    res.json({
        mine: mine.map((p, i) => ({ ...projectView(p), waitingCount: waiting[i] })),
        shared: theirs
            .filter((p) => p.owner && !(record.get(p._id.toString()) && record.get(p._id.toString()).status === "blocked"))
            .map((p) => {
                const rec = record.get(p._id.toString());
                const open = myOpen.filter((c) => c.project.toString() === p._id.toString());
                return {
                    ...projectView(p),
                    owner: userView(p.owner),
                    canFetch: p.openDownloads === true || open.some((c) => CAN_WORK.includes(c.status)),
                    lastFetchedVersion: rec ? rec.lastFetchedVersion : null,
                    contribution: open[0] ? { _id: open[0]._id, status: open[0].status, title: open[0].title } : null,
                };
            }),
    });
}));

// POST /projects?name=&description=[&allowSecrets=1]   body: the project as a zip
projectRouter.post("/projects", userAuth, readZipBody, wrap(async (req, res) => {
    const name = cleanText(req.query.name, 60);
    const description = cleanText(req.query.description, 300);
    if (!name) throw new ProjectError(400, "Give the project a name");
    if ((await Project.countDocuments({ owner: req.user._id })) >= LIMITS.MAX_PROJECTS_PER_USER) {
        throw new ProjectError(409, `You can share up to ${LIMITS.MAX_PROJECTS_PER_USER} projects. Delete one to add another.`);
    }

    const result = ingestZip(req.body, null);
    const overrides = checkSecrets(result, req);

    const project = await Project.create({ owner: req.user._id, name, description });
    let version;
    try {
        version = await commitVersion(project, req.user, result, "First version", overrides);
    } catch (err) {
        await Project.deleteOne({ _id: project._id }).catch(() => {});
        throw err;
    }
    await logActivity(project, req.user, "upload", { detail: { version: version.number, files: result.stats.fileCount, bytes: result.stats.bytes, overrode: overrides } });
    const fresh = await Project.findById(project._id).lean();
    res.status(201).json({ project: projectView(fresh), version: versionView(version), report: result.report });
}));

// GET /projects/:id
projectRouter.get("/projects/:id", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req);
    const owner = ctx.role === "owner" ? req.user : await User.findById(ctx.project.owner).select("name profilePicture");
    const out = {
        project: projectView(ctx.project),
        owner: userView(owner),
        role: ctx.role,
        canFetch: ctx.canFetch,
        lastFetchedVersion: ctx.access ? ctx.access.lastFetchedVersion : null,
    };
    if (ctx.role === "owner") {
        out.waitingCount = await ProjectContribution.countDocuments({ project: ctx.project._id, status: { $in: ["asking", "submitted"] } });
    }
    res.json(out);
}));

// PATCH /projects/:id  { name?, description?, visibility?: "friends"|"private", openDownloads?: boolean }
projectRouter.patch("/projects/:id", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req, { owner: true });
    const body = req.body || {};
    if (body.name !== undefined) {
        const name = cleanText(body.name, 60);
        if (!name) throw new ProjectError(400, "Give the project a name");
        ctx.project.name = name;
    }
    if (body.description !== undefined) ctx.project.description = cleanText(body.description, 300);
    if (body.visibility !== undefined) {
        if (!["friends", "private"].includes(body.visibility)) throw new ProjectError(400, "Choose who can see this project");
        ctx.project.visibility = body.visibility;
    }
    if (body.openDownloads !== undefined) {
        if (typeof body.openDownloads !== "boolean") throw new ProjectError(400, "Choose whether downloads need your approval");
        ctx.project.openDownloads = body.openDownloads;
    }
    await ctx.project.save();
    res.json({ project: projectView(ctx.project) });
}));

// DELETE /projects/:id  (owner) - removes the project, its versions, requests, access and log; frees unused files
projectRouter.delete("/projects/:id", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req, { owner: true });
    const versions = await ProjectVersion.find({ project: ctx.project._id }).select("files.hash").lean();
    const contributions = await ProjectContribution.find({ project: ctx.project._id }).select("changes.hash").lean();
    await ProjectAccess.deleteMany({ project: ctx.project._id });
    await ProjectActivity.deleteMany({ project: ctx.project._id });
    await ProjectContribution.deleteMany({ project: ctx.project._id });
    await ProjectVersion.deleteMany({ project: ctx.project._id });
    await Project.deleteOne({ _id: ctx.project._id });
    await collectGarbage([...versions.flatMap((v) => v.files.map((f) => f.hash)), ...contributions.flatMap((c) => (c.changes || []).map((x) => x.hash))]);
    res.json({ message: "Project deleted" });
}));

// ---------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------

// POST /projects/:id/versions?message=[&allowSecrets=1]   body: zip (whole project, or changed files + manifest)
projectRouter.post("/projects/:id/versions", userAuth, readZipBody, wrap(async (req, res) => {
    const ctx = await authorize(req, { owner: true });
    const previous = await getVersion(ctx.project, undefined);
    const message = cleanText(req.query.message, 200);

    const result = ingestZip(req.body, previous.files);
    const overrides = checkSecrets(result, req);
    const { added, changed, removed } = result.summary;
    if (added + changed + removed === 0) throw new ProjectError(409, `Nothing has changed since v${previous.number}`, { report: result.report });

    const version = await commitVersion(ctx.project, req.user, result, message, overrides);
    await logActivity(ctx.project, req.user, "upload", { detail: { version: version.number, files: result.stats.fileCount, bytes: result.stats.bytes, overrode: overrides, summary: result.summary } });
    res.status(201).json({ version: versionView(version), report: result.report });
}));

// GET /projects/:id/versions
projectRouter.get("/projects/:id/versions", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req);
    const versions = await ProjectVersion.find({ project: ctx.project._id }).sort({ number: -1 }).limit(LIMITS.MAX_VERSIONS).select("-files").populate("contributedBy", "name profilePicture").lean();
    res.json({
        versions: versions.map((v) => (ctx.role === "owner" ? versionView(v) : { number: v.number, message: v.message, createdAt: v.createdAt, contributor: userView(v.contributedBy) })),
    });
}));

// ---------------------------------------------------------------------------
// looking at and fetching the code
// ---------------------------------------------------------------------------

// GET /projects/:id/tree?version=N -> the files. People who may download also get each file's fingerprint
// (they need it to work out what they changed); people who may only look do not.
projectRouter.get("/projects/:id/tree", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req);
    const version = await getVersion(ctx.project, parseVersionNumber(req.query.version));
    res.json({
        version: version.number,
        latestVersion: ctx.project.latestVersion,
        files: version.files.map((f) => (ctx.canFetch ? { path: f.path, size: f.size, hash: f.hash } : { path: f.path, size: f.size })),
    });
}));

// GET /projects/:id/file?path=&version=  -> the text of one file, for the in-browser viewer
projectRouter.get("/projects/:id/file", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req);
    const path = normalizePath(str(req.query.path));
    if (!path) throw new ProjectError(400, "Invalid file path");
    const version = await getVersion(ctx.project, parseVersionNumber(req.query.version));
    const file = version.files.find((f) => f.path === path);
    if (!file) throw new ProjectError(404, "File not found");

    const info = { path, size: file.size, version: version.number };
    if (file.size > LIMITS.MAX_PREVIEW_BYTES) return res.json({ ...info, tooLarge: true });

    let content;
    try {
        content = await inflateRaw(await blobs.readBlob(file.hash));
    } catch (err) {
        console.log("could not read stored file", file.hash, err.message);
        throw new ProjectError(500, "This file could not be read");
    }

    if (ctx.role === "member") {
        const recent = await ProjectActivity.exists({ project: ctx.project._id, actor: req.user._id, type: "view", "detail.path": path, at: { $gt: new Date(Date.now() - VIEW_LOG_WINDOW_MS) } });
        if (!recent) await logActivity(ctx.project, req.user, "view", { detail: { path, version: version.number } });
    }
    if (isBinary(content)) return res.json({ ...info, binary: true });
    res.json({ ...info, content: content.toString("utf8") });
}));

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";

// GET /projects/:id/download?version=N[&since=M]  -> a zip; `since` = only what changed after version M
projectRouter.get("/projects/:id/download", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req);
    if (!ctx.canFetch) throw new ProjectError(403, NO_DOWNLOAD);
    const version = await getVersion(ctx.project, parseVersionNumber(req.query.version));

    let list = version.files;
    let removed = [];
    const since = parseVersionNumber(req.query.since);
    if (since !== undefined) {
        if (since >= version.number) throw new ProjectError(400, "Choose an older version to compare with");
        const base = await ProjectVersion.findOne({ project: ctx.project._id, number: since }).lean();
        if (!base) throw new ProjectError(404, "That version is no longer available - download the full project instead");
        const diff = diffManifests(base.files, list);
        const wanted = new Set([...diff.added, ...diff.changed]);
        list = list.filter((f) => wanted.has(f.path));
        removed = diff.removed;
        if (list.length === 0 && removed.length === 0) throw new ProjectError(409, "Nothing has changed between those versions");
    }
    if (list.length === 0 && removed.length === 0) throw new ProjectError(404, "There are no files to download");

    // make sure every stored file is really there BEFORE sending anything (never a half-good zip)
    for (const f of list) {
        if (!(await blobs.hasBlob(f.hash))) {
            console.log("missing stored file", f.hash, "for", f.path);
            throw new ProjectError(500, "Some of this project's files are missing on the server. Please ask the owner to upload it again.");
        }
    }

    const entries = list.map((f) => ({ name: f.path, crc: f.crc, size: f.size, csize: f.csize, mtime: version.createdAt, source: { path: blobs.blobPath(f.hash) } }));
    if (removed.length) {
        entries.push(entryFromBuffer("TECHMATES_REMOVED.txt", `Files deleted since v${since} - remove them from your copy:\n\n${removed.join("\n")}\n`, version.createdAt));
    }
    const plan = planZip(entries);

    if (ctx.role === "member") {
        await logActivity(ctx.project, req.user, "fetch", {
            detail: { version: version.number, since: since ?? null, files: list.length, bytes: list.reduce((n, f) => n + f.size, 0) },
        });
        await recordFetch(ctx.project, req.user._id, version.number);
    }

    const filename = `${slug(ctx.project.name)}-v${version.number}${since !== undefined ? `-changes-since-v${since}` : ""}.zip`;
    res.status(200);
    res.set({
        "Content-Type": "application/zip",
        "Content-Length": String(plan.totalLength),
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    try {
        await streamZip(res, entries, plan);
    } catch (err) {
        console.log("download failed part-way", err.message);
        res.destroy(); // a cut-off connection is better than a zip that looks complete but is not
    }
}));

// ---------------------------------------------------------------------------
// who can see it: everybody you are connected with, except the people you block
// ---------------------------------------------------------------------------

// GET /projects/:id/access (owner) -> every connection, and whether they are blocked
projectRouter.get("/projects/:id/access", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req, { owner: true });
    const ids = await friendIds(req.user._id);
    if (ids.length === 0) return res.json({ people: [] });
    const users = await User.find({ _id: { $in: ids } }).select("name profilePicture").lean();
    const records = await ProjectAccess.find({ project: ctx.project._id, user: { $in: ids } }).lean();
    const open = await ProjectContribution.find({ project: ctx.project._id, author: { $in: ids }, status: { $in: OPEN } }).select("author").lean();
    const record = new Map(records.map((r) => [r.user.toString(), r]));
    const people = users
        .map((u) => {
            const rec = record.get(u._id.toString());
            return {
                user: userView(u),
                blocked: Boolean(rec && rec.status === "blocked"),
                lastFetchedVersion: rec ? rec.lastFetchedVersion : null,
                openRequests: open.filter((c) => c.author.toString() === u._id.toString()).length,
            };
        })
        .sort((a, b) => a.user.name.localeCompare(b.user.name));
    res.json({ people });
}));

// PUT /projects/:id/access/:userId { blocked: boolean } (owner). A blocked person no longer sees the project at all.
projectRouter.put("/projects/:id/access/:userId", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req, { owner: true });
    const { userId } = req.params;
    const blocked = (req.body || {}).blocked;
    if (!isId(userId)) throw new ProjectError(404, "Developer not found");
    if (typeof blocked !== "boolean") throw new ProjectError(400, "Choose block or unblock");
    if (!(await isConnected(req.user._id, userId))) throw new ProjectError(404, "Developer not found");
    const person = await User.findById(userId).select("name profilePicture");
    if (!person) throw new ProjectError(404, "Developer not found");

    let record = await ProjectAccess.findOne({ project: ctx.project._id, user: userId });
    if (blocked) {
        if (record) {
            record.status = "blocked";
            record.blockedAt = new Date();
            await record.save();
        } else {
            record = await ProjectAccess.create({ project: ctx.project._id, user: userId, status: "blocked", blockedAt: new Date() });
        }
        // whatever they had going ends with their access
        const open = await ProjectContribution.find({ project: ctx.project._id, author: userId, status: { $in: OPEN } });
        const freed = [];
        for (const c of open) {
            freed.push(...c.changes.map((x) => x.hash));
            c.status = "declined";
            c.decisionNote = ""; // nothing written by the owner; the screen says "declined"
            c.decidedAt = new Date();
            c.changes = [];
            await c.save();
        }
        await collectGarbage(freed);
    } else if (record && record.status === "blocked") {
        record.status = "active";
        record.blockedAt = undefined;
        await record.save();
    }
    await logActivity(ctx.project, req.user, blocked ? "block" : "unblock", { target: person._id });
    res.json({ person: { user: userView(person), blocked, lastFetchedVersion: record ? record.lastFetchedVersion : null } });
}));

// ---------------------------------------------------------------------------
// activity
// ---------------------------------------------------------------------------

// GET /projects/:id/activity?before=<id>&limit=30  (owner)
projectRouter.get("/projects/:id/activity", userAuth, wrap(async (req, res) => {
    const ctx = await authorize(req, { owner: true });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const filter = { project: ctx.project._id };
    if (req.query.before !== undefined) {
        if (!isId(str(req.query.before))) throw new ProjectError(400, "Invalid cursor");
        filter._id = { $lt: req.query.before };
    }
    const rows = await ProjectActivity.find(filter).sort({ _id: -1 }).limit(limit + 1).populate("actor", "name profilePicture").populate("target", "name profilePicture").lean();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    res.json({
        activity: page.map((a) => ({ _id: a._id, type: a.type, at: a.at, actor: userView(a.actor), target: userView(a.target), detail: a.detail || {} })),
        hasMore,
        nextCursor: hasMore ? page[page.length - 1]._id : null,
    });
}));

// asking to work on the project, sending changes, the owner's review
projectRouter.use(require("./contributionRoutes"));

module.exports = projectRouter;
