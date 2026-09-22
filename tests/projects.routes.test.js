"use strict";
// Runs the REAL project routes (real Express, real body parsing, real streaming) against an
// in-memory database stand-in. Covers the consent rules end to end.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-routes-"));
process.env.PROJECT_STORAGE_DIR = path.join(tmp, "store");

const express = require("express");
const { build } = require("./helpers/fakeDb");
const db = build();

function inject(rel, exports) {
    const file = require.resolve(rel);
    require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
}
inject("../src/models/project", db.Project);
inject("../src/models/projectVersion", db.ProjectVersion);
inject("../src/models/projectAccess", db.ProjectAccess);
inject("../src/models/projectActivity", db.ProjectActivity);
inject("../src/models/projectContribution", db.ProjectContribution);
inject("../src/models/connectionRequest", db.ConnectionRequest);
inject("../src/models/message", db.Message);
inject("../src/models/userSchema", db.User);
inject("../src/middlewares/auth", {
    userAuth: async (req, res, next) => {
        const id = req.get("x-test-user");
        const user = id && (await db.User.findById(id));
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        req.user = user;
        next();
    },
});

const routes = require("../src/routes/projectRoutes");
const zip = require("../src/utils/zipfile");
const { LIMITS } = require("../src/utils/projectFiles");
const blobs = require("../src/utils/blobStore");
const { sweepOrphanBlobs } = require("../src/utils/blobSweeper");
const { isBlobUsed } = require("../src/routes/projectCommon");
const { sha256 } = require("../src/utils/projectIngest");

let server;
let base;
const U = {};
const P = {}; // project ids etc.

test.before(async () => {
    for (const [key, name] of [["A", "Alice Owner"], ["B", "Bob Dev"], ["C", "Carl Unconnected"], ["D", "Dana Stranger"], ["E", "Eve Dev"]]) {
        U[key] = (await db.User.create({ name, profilePicture: "https://x/y.png" }))._id;
    }
    await db.ConnectionRequest.create({ fromUserId: U.A, toUserId: U.B, status: "accepted" });
    await db.ConnectionRequest.create({ fromUserId: U.E, toUserId: U.A, status: "accepted" }); // the other direction
    await db.ConnectionRequest.create({ fromUserId: U.C, toUserId: U.A, status: "interested" }); // not accepted
    const app = express();
    app.use(express.json());
    app.use("/", routes);
    server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

async function call(user, method, url, { json, body, type } = {}) {
    const headers = {};
    if (user) headers["x-test-user"] = U[user];
    let payload = body;
    if (json !== undefined) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(json);
    } else if (body !== undefined) headers["content-type"] = type || "application/zip";
    const res = await fetch(base + url, { method, headers, body: payload });
    const buf = Buffer.from(await res.arrayBuffer());
    let parsed = null;
    if ((res.headers.get("content-type") || "").includes("json")) parsed = JSON.parse(buf.toString("utf8"));
    return { status: res.status, json: parsed, buf, headers: res.headers };
}

const z = (list) => zip.makeZip(list.map(([name, data]) => ({ name, data })));
const manifestOf = (list) => ({ name: ".techmates/manifest.json", data: JSON.stringify({ v: 1, files: list.map(([p, c]) => ({ path: p, hash: sha256(Buffer.from(c)) })) }) });
function unzipList(buf) {
    const f = path.join(tmp, `dl-${Math.random().toString(36).slice(2)}.zip`);
    fs.writeFileSync(f, buf);
    execFileSync("unzip", ["-tq", f]);
    const names = execFileSync("unzip", ["-Z1", f]).toString().split("\n").filter(Boolean).sort();
    return { names, read: (n) => execFileSync("unzip", ["-p", f, n]).toString() };
}
const SRC = [
    ["package.json", '{"name":"demo"}'],
    ["src/index.js", "console.log('hello');\n"],
    ["src/util/math.js", "export const add = (a, b) => a + b;\n"],
    ["docs/guide.md", "# Guide\n"],
    ["assets/logo.bin", Buffer.from([0, 1, 2, 3, 0, 0, 9])],
];

// ---------------------------------------------------------------------------
const V1 = [...SRC, [".env.example", "TOKEN="]];
const blobRoot = () => path.join(process.env.PROJECT_STORAGE_DIR, "blobs");
const blobCount = () => (fs.existsSync(blobRoot()) ? fs.readdirSync(blobRoot()).flatMap((d) => fs.readdirSync(path.join(blobRoot(), d))).length : 0);
function ageBlobs() {
    const past = new Date(Date.now() - 3600 * 1000);
    fs.readdirSync(blobRoot()).flatMap((d) => fs.readdirSync(path.join(blobRoot(), d)).map((f) => path.join(blobRoot(), d, f))).forEach((f) => fs.utimesSync(f, past, past));
}
const INTENT = "The greeting in index.js is hard to change. I want to move it into a constant and remove the unused guide.";
const EXPLAIN = "Moved the greeting into a constant so it can be changed in one place, added a small helper file, and removed the outdated guide.";
const asks = (user, json) => call(user, "POST", `/projects/${P.id}/contributions`, { json });
const decide = (cid, action, note) => call("A", "POST", `/projects/${P.id}/contributions/${cid}/decision`, { json: { action, note } });
const explain = (user, cid, explanation) => call(user, "PATCH", `/projects/${P.id}/contributions/${cid}`, { json: { explanation } });
// what the CLI / browser sends: a manifest of the whole project plus only the files that differ from the copy they downloaded
const deltaZip = (now, changedPaths) => zip.makeZip([manifestOf(now), ...now.filter(([p]) => changedPaths.includes(p)).map(([p, c]) => ({ name: p, data: c }))]);
const send = (user, cid, now, changedPaths, base = 1, q = "") => call(user, "POST", `/projects/${P.id}/contributions/${cid}/changes?base=${base}${q}`, { body: deltaZip(now, changedPaths) });
const activityTypes = async () => (await call("A", "GET", `/projects/${P.id}/activity?limit=100`)).json.activity.map((a) => a.type);

test("upload: needs login, a name and a real zip; rejects too-large and wrong bodies", async () => {
    assert.equal((await call(null, "POST", "/projects?name=x", { body: z(SRC) })).status, 401);
    let r = await call("A", "POST", "/projects", { body: z(SRC) });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /name/i);
    r = await call("A", "POST", "/projects?name=Demo", { body: Buffer.from("hello, not a zip") });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not a valid zip/);
    r = await call("A", "POST", "/projects?name=Demo", { body: "text", type: "text/plain" });
    assert.equal(r.status, 400); // wrong content type -> empty body
    r = await call("A", "POST", "/projects?name=Demo", { body: Buffer.alloc(LIMITS.MAX_ZIP_BYTES + 1024) });
    assert.equal(r.status, 413);
    assert.match(r.json.error, /too large/);
    assert.equal(db.Project._rows.length, 0, "nothing was created by the failed uploads");
});

test("upload: suspected secrets stop the upload (masked), unless the owner overrides", async () => {
    const withSecret = z([...SRC, ["config/db.js", 'mongoose.connect("mongodb+srv://u:Fd5lwmMfJ9AfX38m@c.mongodb.net/x");']]);
    let r = await call("A", "POST", "/projects?name=Leaky", { body: withSecret });
    assert.equal(r.status, 422);
    assert.equal(r.json.code, "SECRETS_FOUND");
    assert.equal(r.json.findings[0].path, "config/db.js");
    assert.ok(!r.buf.toString().includes("Fd5lwmMfJ9AfX38m"), "the secret must never be echoed back");
    assert.equal(db.Project._rows.length, 0);
    assert.equal(db.ProjectVersion._rows.length, 0);
    r = await call("A", "POST", "/projects?name=Leaky&allowSecrets=1", { body: withSecret });
    assert.equal(r.status, 201);
    assert.equal(db.ProjectActivity._rows.find((a) => a.type === "upload").detail.overrode, 1, "the override is recorded");
    await call("A", "DELETE", `/projects/${r.json.project._id}`);
    assert.equal(db.Project._rows.length, 0);
});

test("upload: creates project v1, reports what was left out, stores each file once", async () => {
    const zipBuf = z([...V1, ["node_modules/left-pad/index.js", "x"], [".env", "TOKEN=abc"], [".DS_Store", "x"]]);
    const r = await call("A", "POST", "/projects?name=%20Demo%20Project%20&description=A%20demo", { body: zipBuf });
    assert.equal(r.status, 201);
    P.id = r.json.project._id;
    assert.equal(r.json.project.name, "Demo Project");
    assert.equal(r.json.project.latestVersion, 1);
    assert.equal(r.json.project.fileCount, 6);
    assert.equal(r.json.project.visibility, "friends");
    assert.equal(r.json.project.openDownloads, false);
    assert.deepEqual(r.json.report.skipped.map((s) => s.label).sort(), [".DS_Store", "node_modules/"]);
    assert.deepEqual(r.json.report.excluded, [{ path: ".env", reason: "environment file" }]);
    const list = await call("A", "GET", "/projects");
    assert.equal(list.json.mine.length, 1);
    assert.equal(list.json.mine[0].waitingCount, 0);
    assert.equal(list.json.shared.length, 0);
    const before = blobCount();
    const second = await call("A", "POST", "/projects?name=Copy", { body: zipBuf });
    assert.equal(second.status, 201);
    assert.equal(blobCount(), before, "no new blobs for identical content");
    P.copy = second.json.project._id;
});

test("project limit per user; deleting a copy never breaks the original", async () => {
    const old = LIMITS.MAX_PROJECTS_PER_USER;
    LIMITS.MAX_PROJECTS_PER_USER = 2;
    const r = await call("A", "POST", "/projects?name=Third", { body: z(SRC) });
    LIMITS.MAX_PROJECTS_PER_USER = old;
    assert.equal(r.status, 409);
    await call("A", "DELETE", `/projects/${P.copy}`);
    const tree = await call("A", "GET", `/projects/${P.id}/tree`);
    for (const f of tree.json.files) assert.equal((await call("A", "GET", `/projects/${P.id}/file?path=${encodeURIComponent(f.path)}`)).status, 200, f.path);
});

test("people who are not connected with the owner cannot even tell the project exists", async () => {
    for (const who of ["C", "D"]) {
        for (const url of ["", "/tree", "/file?path=package.json", "/download", "/versions", "/contributions"]) {
            const r = await call(who, "GET", `/projects/${P.id}${url}`);
            assert.equal(r.status, 404, `${who} ${url}`);
            assert.equal(r.json.error, "Project not found");
        }
        assert.equal((await asks(who, { title: "Let me in", intent: INTENT })).status, 404, `${who} cannot ask`);
    }
    assert.equal((await call("B", "GET", "/projects/not-an-id")).status, 404);
    assert.equal((await call("B", "GET", `/projects/${"0".repeat(24)}`)).status, 404);
    assert.equal((await call("D", "GET", "/projects")).json.shared.length, 0);
    assert.equal((await call("C", "GET", "/projects")).json.shared.length, 0, "a pending connection request is not a connection");
    assert.equal(db.ProjectContribution._rows.length, 0);
});

test("every connection can look at the project without being invited, in either connection direction", async () => {
    for (const [who, name] of [["B", "Bob Dev"], ["E", "Eve Dev"]]) {
        const shared = await call(who, "GET", "/projects");
        assert.equal(shared.json.shared.length, 1, name);
        assert.equal(shared.json.shared[0].owner.name, "Alice Owner");
        assert.equal(shared.json.shared[0].canFetch, false);
        assert.equal(shared.json.shared[0].contribution, null);
        assert.equal(shared.json.mine.length, 0);
        const info = await call(who, "GET", `/projects/${P.id}`);
        assert.equal(info.json.role, "member");
        assert.equal(info.json.canFetch, false);
        assert.equal(info.json.waitingCount, undefined, "only the owner sees what is waiting");
        const tree = await call(who, "GET", `/projects/${P.id}/tree`);
        assert.deepEqual(tree.json.files.map((f) => f.path), [".env.example", "assets/logo.bin", "docs/guide.md", "package.json", "src/index.js", "src/util/math.js"]);
        assert.ok(tree.json.files.every((f) => f.hash === undefined), "fingerprints are only for people who may download");
    }
    const r = await call("B", "GET", `/projects/${P.id}/file?path=src/index.js`);
    assert.equal(r.status, 200);
    assert.equal(r.json.content, "console.log('hello');\n");
    assert.equal((await call("B", "GET", `/projects/${P.id}/file?path=does/not/exist.js`)).status, 404);
    for (const bad of ["../../etc/passwd", "/etc/passwd", "src/../package.json", ""]) {
        const rr = await call("B", "GET", `/projects/${P.id}/file?path=${encodeURIComponent(bad)}`);
        assert.ok([400, 404].includes(rr.status), bad);
        assert.ok(!("content" in (rr.json || {})));
    }
    const versions = await call("B", "GET", `/projects/${P.id}/versions`);
    assert.deepEqual(Object.keys(versions.json.versions[0]).sort(), ["contributor", "createdAt", "message", "number"]);
});

test("looking is free, but taking a copy is not: no download in any form until the owner approves", async () => {
    for (const q of ["", "?version=1", "?since=1"]) {
        for (const who of ["B", "E"]) {
            const r = await call(who, "GET", `/projects/${P.id}/download${q}`);
            assert.equal(r.status, 403, `${who} ${q}`);
            assert.match(r.json.error, /Ask the owner/);
        }
    }
    assert.equal((await call("A", "GET", `/projects/${P.id}/download`)).status, 200, "the owner can always download");
});

test("members can do nothing that only the owner may do", async () => {
    assert.equal((await call("B", "GET", `/projects/${P.id}/activity`)).status, 403);
    assert.equal((await call("B", "GET", `/projects/${P.id}/access`)).status, 403);
    assert.equal((await call("B", "PUT", `/projects/${P.id}/access/${U.E}`, { json: { blocked: true } })).status, 403);
    assert.equal((await call("B", "PATCH", `/projects/${P.id}`, { json: { name: "hacked" } })).status, 403);
    assert.equal((await call("B", "PATCH", `/projects/${P.id}`, { json: { openDownloads: true } })).status, 403);
    assert.equal((await call("B", "PATCH", `/projects/${P.id}`, { json: { visibility: "private" } })).status, 403);
    assert.equal((await call("B", "DELETE", `/projects/${P.id}`)).status, 403);
    assert.equal((await call("B", "POST", `/projects/${P.id}/versions`, { body: z(SRC) })).status, 403);
    // the old invite endpoints are gone
    assert.equal((await call("A", "POST", `/projects/${P.id}/members`, { json: { userId: U.B, level: "fetch" } })).status, 404);
    const p = db.Project._rows.find((x) => x._id === P.id);
    assert.deepEqual([p.name, p.openDownloads, p.visibility], ["Demo Project", false, "friends"]);
});

test("binary and oversized files are not dumped into the viewer", async () => {
    const r = await call("A", "GET", `/projects/${P.id}/file?path=assets/logo.bin`);
    assert.deepEqual([r.json.binary, r.json.content], [true, undefined]);
    const old = LIMITS.MAX_PREVIEW_BYTES;
    LIMITS.MAX_PREVIEW_BYTES = 10;
    const big = await call("A", "GET", `/projects/${P.id}/file?path=src/index.js`);
    LIMITS.MAX_PREVIEW_BYTES = old;
    assert.deepEqual([big.json.tooLarge, big.json.content], [true, undefined]);
});

test("the owner's activity log shows who looked at what (repeat views collapse; the owner's own do not count)", async () => {
    await call("B", "GET", `/projects/${P.id}/file?path=src/index.js`);
    await call("A", "GET", `/projects/${P.id}/file?path=src/index.js`);
    const r = await call("A", "GET", `/projects/${P.id}/activity`);
    const views = r.json.activity.filter((a) => a.type === "view");
    assert.equal(views.length, 1, "Bob looked twice within 10 minutes: one entry");
    assert.equal(views[0].actor.name, "Bob Dev");
    assert.equal(views[0].detail.path, "src/index.js");
});

test("the owner can hide the project from everyone (private), and bring it back", async () => {
    assert.equal((await call("A", "PATCH", `/projects/${P.id}`, { json: { visibility: "public" } })).status, 400);
    assert.equal((await call("A", "PATCH", `/projects/${P.id}`, { json: { visibility: "private" } })).json.project.visibility, "private");
    for (const who of ["B", "E"]) {
        for (const url of ["", "/tree", "/file?path=package.json", "/download", "/contributions"]) assert.equal((await call(who, "GET", `/projects/${P.id}${url}`)).status, 404, `${who} ${url}`);
        assert.equal((await call(who, "GET", "/projects")).json.shared.length, 0);
        assert.equal((await asks(who, { title: "Let me in", intent: INTENT })).status, 404);
    }
    assert.equal((await call("A", "GET", `/projects/${P.id}/tree`)).status, 200, "still the owner's");
    assert.equal((await call("A", "PATCH", `/projects/${P.id}`, { json: { visibility: "friends" } })).json.project.visibility, "friends");
    assert.equal((await call("B", "GET", `/projects/${P.id}/tree`)).status, 200);
});

test("the owner can block one connection: they see nothing, and can be let back in", async () => {
    const people = await call("A", "GET", `/projects/${P.id}/access`);
    assert.deepEqual(people.json.people.map((x) => [x.user.name, x.blocked]), [["Bob Dev", false], ["Eve Dev", false]], "only connections are listed");
    assert.equal((await call("A", "PUT", `/projects/${P.id}/access/${U.D}`, { json: { blocked: true } })).status, 404, "a stranger is not a connection");
    assert.equal((await call("A", "PUT", `/projects/${P.id}/access/${U.C}`, { json: { blocked: true } })).status, 404);
    assert.equal((await call("A", "PUT", `/projects/${P.id}/access/${U.B}`, { json: { blocked: "yes" } })).status, 400);
    assert.equal((await call("A", "PUT", `/projects/${P.id}/access/nope`, { json: { blocked: true } })).status, 404);

    assert.equal((await call("A", "PUT", `/projects/${P.id}/access/${U.B}`, { json: { blocked: true } })).json.person.blocked, true);
    for (const url of ["", "/tree", "/file?path=package.json", "/download", "/versions", "/contributions"]) assert.equal((await call("B", "GET", `/projects/${P.id}${url}`)).status, 404, url);
    assert.equal((await call("B", "GET", "/projects")).json.shared.length, 0);
    assert.equal((await asks("B", { title: "Let me in", intent: INTENT })).status, 404);
    assert.equal((await call("E", "GET", `/projects/${P.id}/tree`)).status, 200, "nobody else is affected");
    assert.equal((await call("A", "GET", `/projects/${P.id}/access`)).json.people.find((x) => x.user.name === "Bob Dev").blocked, true);

    assert.equal((await call("A", "PUT", `/projects/${P.id}/access/${U.B}`, { json: { blocked: false } })).json.person.blocked, false);
    assert.equal((await call("B", "GET", `/projects/${P.id}/tree`)).status, 200);
    assert.equal((await call("A", "PUT", `/projects/${P.id}/access/${U.E}`, { json: { blocked: false } })).status, 200, "unblocking someone who was never blocked is harmless");
    const types = await activityTypes();
    assert.ok(types.includes("block") && types.includes("unblock"));
});

test("open downloads: the owner can let friends take a copy without asking; turning it off closes it again", async () => {
    assert.equal((await call("A", "PATCH", `/projects/${P.id}`, { json: { openDownloads: "yes" } })).status, 400);
    assert.equal((await call("A", "PATCH", `/projects/${P.id}`, { json: { openDownloads: true } })).json.project.openDownloads, true);
    let r = await call("E", "GET", `/projects/${P.id}/download`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/zip");
    assert.equal(Number(r.headers.get("content-length")), r.buf.length);
    assert.match(r.headers.get("content-disposition"), /attachment; filename="demo-project-v1\.zip"/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    const out = unzipList(r.buf);
    assert.deepEqual(out.names, [".env.example", "assets/logo.bin", "docs/guide.md", "package.json", "src/index.js", "src/util/math.js"]);
    assert.equal(out.read("src/util/math.js"), "export const add = (a, b) => a + b;\n");
    assert.equal(db.ProjectAccess._rows.find((g) => g.user === U.E).lastFetchedVersion, 1);
    const tree = await call("E", "GET", `/projects/${P.id}/tree`);
    assert.ok(tree.json.files.every((f) => /^[0-9a-f]{64}$/.test(f.hash)), "with download comes the fingerprint");
    const fetches = (await call("A", "GET", `/projects/${P.id}/activity`)).json.activity.filter((a) => a.type === "fetch");
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].actor.name, "Eve Dev");
    assert.equal(fetches[0].detail.files, 6);
    assert.equal((await call("E", "GET", "/projects")).json.shared[0].canFetch, true);

    await call("A", "PATCH", `/projects/${P.id}`, { json: { openDownloads: false } });
    assert.equal((await call("E", "GET", `/projects/${P.id}/download`)).status, 403);
});

// ---------------------------------------------------------------------------
// asking to work on the project
// ---------------------------------------------------------------------------
test("asking: a real title and a real explanation are required; the owner asks nobody", async () => {
    const good = { title: "Move the greeting into a constant", intent: INTENT };
    assert.equal((await call(null, "POST", `/projects/${P.id}/contributions`, { json: good })).status, 401);
    assert.equal((await asks("B", { ...good, title: "hi" })).status, 400);
    assert.equal((await asks("B", { ...good, title: undefined })).status, 400);
    let r = await asks("B", { ...good, intent: "please let me" });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /what you want to improve and why/i);
    assert.equal((await asks("B", { ...good, intent: "x".repeat(1501) })).status, 400);
    assert.equal((await asks("B", { ...good, intent: 42 })).status, 400);
    assert.equal((await asks("A", good)).status, 400, "it is your own project");
    assert.equal(db.ProjectContribution._rows.length, 0, "nothing was created by the bad requests");

    r = await asks("B", { ...good, title: "  Move the greeting into a constant  " });
    assert.equal(r.status, 201);
    P.c1 = r.json.contribution._id;
    assert.deepEqual([r.json.contribution.status, r.json.contribution.title, r.json.contribution.author.name], ["asking", "Move the greeting into a constant", "Bob Dev"]);
    assert.equal(r.json.contribution.explanation, "");
});

test("a request is private to its author and the owner", async () => {
    const mine = await call("B", "GET", `/projects/${P.id}/contributions`);
    assert.equal(mine.json.contributions.length, 1);
    assert.equal((await call("E", "GET", `/projects/${P.id}/contributions`)).json.contributions.length, 0, "Eve sees none of Bob's");
    assert.equal((await call("E", "GET", `/projects/${P.id}/contributions/${P.c1}`)).status, 404);
    assert.equal((await call("E", "GET", `/projects/${P.id}/contributions/${P.c1}/diff?path=a`)).status, 404);
    assert.equal((await call("E", "PATCH", `/projects/${P.id}/contributions/${P.c1}`, { json: { explanation: EXPLAIN } })).status, 404);
    assert.equal((await call("E", "DELETE", `/projects/${P.id}/contributions/${P.c1}`)).status, 404);
    assert.equal((await call("B", "GET", `/projects/${P.id}/contributions/not-an-id`)).status, 404);
    const owner = await call("A", "GET", `/projects/${P.id}/contributions`);
    assert.deepEqual(owner.json.contributions.map((c) => [c.author.name, c.status]), [["Bob Dev", "asking"]]);
    assert.equal((await call("A", "GET", `/projects/${P.id}`)).json.waitingCount, 1);
    assert.equal((await call("A", "GET", "/projects")).json.mine[0].waitingCount, 1);
    const shared = (await call("B", "GET", "/projects")).json.shared[0];
    assert.deepEqual([shared.contribution.status, shared.canFetch], ["asking", false]);
    assert.ok((await activityTypes()).includes("ask"));
});

test("nothing can be downloaded or sent before the owner has said yes", async () => {
    assert.equal((await call("B", "GET", `/projects/${P.id}/download`)).status, 403);
    assert.equal((await explain("B", P.c1, EXPLAIN)).status, 409);
    const now = [...V1];
    now[1] = ["src/index.js", "console.log('changed');\n"];
    const r = await send("B", P.c1, now, ["src/index.js"]);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /approved/);
    assert.equal(db.ProjectContribution._rows[0].changes.length, 0);
});

test("only the owner decides; approving opens the download for that person only", async () => {
    assert.equal((await call("B", "POST", `/projects/${P.id}/contributions/${P.c1}/decision`, { json: { action: "approve" } })).status, 403, "you cannot approve yourself");
    assert.equal((await decide(P.c1, "shrug")).status, 400);
    assert.equal((await decide(P.c1, "merge")).status, 409, "nothing to merge yet");
    assert.equal((await decide(P.c1, "request-changes", "not yet submitted")).status, 409);
    let r = await decide(P.c1, "approve", "Sure - keep it small");
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.contribution.status, r.json.contribution.decisionNote], ["approved", "Sure - keep it small"]);
    assert.equal((await decide(P.c1, "approve")).status, 409, "already decided");

    assert.equal((await call("B", "GET", `/projects/${P.id}`)).json.canFetch, true);
    assert.equal((await call("B", "GET", "/projects")).json.shared[0].canFetch, true);
    assert.ok((await call("B", "GET", `/projects/${P.id}/tree`)).json.files.every((f) => f.hash));
    r = await call("B", "GET", `/projects/${P.id}/download`);
    assert.equal(r.status, 200);
    assert.equal(db.ProjectAccess._rows.find((g) => g.user === U.B).lastFetchedVersion, 1, "remembered as the version B is working from");
    assert.equal((await call("E", "GET", `/projects/${P.id}/download`)).status, 403, "Eve was not approved");
    assert.ok((await activityTypes()).includes("approve"));
});

test("sending changes needs an explanation first, and refuses secrets, empty changes and unknown versions", async () => {
    const now = [["package.json", '{"name":"demo"}'], ["src/index.js", "const GREETING = 'hello';\nconsole.log(GREETING);\n"], ["src/util/math.js", "export const add = (a, b) => a + b;\n"], ["src/util/new.js", "export const n = 1;\n"], ["assets/logo.bin", Buffer.from([0, 1, 2, 3, 0, 0, 9, 9])], [".env.example", "TOKEN="]];
    const changed = ["src/index.js", "src/util/new.js", "assets/logo.bin"];
    let r = await send("B", P.c1, now, changed);
    assert.equal(r.status, 400, "no explanation yet");
    assert.equal(r.json.code, "EXPLANATION_REQUIRED");
    assert.equal((await explain("B", P.c1, "fixed it")).status, 400, "too short");
    assert.equal((await explain("B", P.c1, "y".repeat(2001))).status, 400);
    assert.equal((await explain("A", P.c1, EXPLAIN)).status, 403, "the owner does not write the author's explanation");
    r = await explain("B", P.c1, `  ${EXPLAIN}  `);
    assert.equal(r.status, 200);
    assert.equal(r.json.contribution.explanation, EXPLAIN);
    assert.equal(r.json.contribution.status, "approved", "saving the explanation is not sending");

    // secrets: refused, and "share anyway" does not exist here
    const before = blobCount();
    const leaky = [...now, ["config/db.js", 'mongoose.connect("mongodb+srv://u:Fd5lwmMfJ9AfX38m@c.mongodb.net/x");']];
    for (const q of ["", "&allowSecrets=1"]) {
        r = await send("B", P.c1, leaky, [...changed, "config/db.js"], 1, q);
        assert.equal(r.status, 422, q);
        assert.equal(r.json.code, "SECRETS_FOUND");
        assert.ok(!r.buf.toString().includes("Fd5lwmMfJ9AfX38m"));
    }
    assert.equal(blobCount(), before, "refused changes are not stored");
    assert.equal(db.ProjectContribution._rows[0].status, "approved");

    r = await send("B", P.c1, V1, []);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /Nothing differs from v1/);
    assert.equal((await send("B", P.c1, now, changed, 99)).status, 404);
    assert.match((await send("B", P.c1, now, changed, 99)).json.error, /no longer available/);
    assert.equal((await send("B", P.c1, now, changed, "abc")).status, 400);
    const evil = zip.makeZip([manifestOf([["stolen.txt", "never uploaded"]])]);
    assert.equal((await call("B", "POST", `/projects/${P.id}/contributions/${P.c1}/changes?base=1`, { body: evil })).status, 400);
    assert.equal((await call("E", "POST", `/projects/${P.id}/contributions/${P.c1}/changes?base=1`, { body: deltaZip(now, changed) })).status, 404);
    assert.equal((await call("A", "POST", `/projects/${P.id}/contributions/${P.c1}/changes?base=1`, { body: deltaZip(now, changed) })).status, 403);

    r = await send("B", P.c1, now, changed);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.contribution.status, "submitted");
    assert.deepEqual(r.json.contribution.summary, { added: 1, changed: 2, removed: 1 }, "guide.md is missing from the manifest, so it is a deletion");
    assert.deepEqual(r.json.contribution.changes.map((c) => [c.kind, c.path]).sort(), [["added", "src/util/new.js"], ["changed", "assets/logo.bin"], ["changed", "src/index.js"], ["removed", "docs/guide.md"]]);
    assert.equal(r.json.contribution.baseVersion, 1);
    P.now1 = now;

    // nothing reached the project itself
    const info = await call("A", "GET", `/projects/${P.id}`);
    assert.equal(info.json.project.latestVersion, 1);
    assert.equal((await call("A", "GET", `/projects/${P.id}/file?path=src/index.js`)).json.content, "console.log('hello');\n");
    assert.equal(info.json.waitingCount, 1);
    assert.ok((await activityTypes()).includes("submit"));
});

test("the owner reads the explanation and the exact line changes before deciding", async () => {
    const one = await call("A", "GET", `/projects/${P.id}/contributions/${P.c1}`);
    assert.equal(one.json.contribution.intent, INTENT);
    assert.equal(one.json.contribution.explanation, EXPLAIN);
    const diff = (p, who = "A") => call(who, "GET", `/projects/${P.id}/contributions/${P.c1}/diff?path=${encodeURIComponent(p)}`);

    let r = await diff("src/index.js");
    assert.equal(r.status, 200);
    assert.equal(r.json.kind, "changed");
    assert.deepEqual([r.json.added, r.json.removed], [2, 1]);
    assert.deepEqual(r.json.hunks[0].lines.map((l) => l.t + l.text), ["-console.log('hello');", "+const GREETING = 'hello';", "+console.log(GREETING);"]);
    r = await diff("src/util/new.js");
    assert.deepEqual([r.json.kind, r.json.added, r.json.removed], ["added", 1, 0]);
    r = await diff("docs/guide.md");
    assert.deepEqual([r.json.kind, r.json.added, r.json.removed], ["removed", 0, 1]);
    assert.equal((await diff("assets/logo.bin")).json.binary, true);
    assert.equal((await diff("package.json")).status, 404, "an untouched file is not part of the request");
    assert.equal((await diff("../etc/passwd")).status, 404);
    assert.equal((await diff("src/index.js", "B")).status, 200, "the author can read the same diff");
    const old = LIMITS.MAX_PREVIEW_BYTES;
    LIMITS.MAX_PREVIEW_BYTES = 5;
    assert.equal((await diff("src/index.js")).json.tooLarge, true);
    LIMITS.MAX_PREVIEW_BYTES = old;
});

test("the owner can ask for changes (with a reason); the author fixes it and sends again", async () => {
    assert.equal((await decide(P.c1, "request-changes")).status, 400, "a reason is required");
    assert.equal((await decide(P.c1, "request-changes", "x")).status, 400);
    assert.equal((await decide(P.c1, "request-changes", "y".repeat(501))).status, 400);
    let r = await decide(P.c1, "request-changes", "Please keep the guide, I still use it.");
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.contribution.status, r.json.contribution.decisionNote], ["changes-requested", "Please keep the guide, I still use it."]);
    assert.equal((await decide(P.c1, "merge")).status, 409, "cannot merge until it is sent again");
    assert.equal((await call("B", "GET", `/projects/${P.id}/download`)).status, 200, "still allowed to work");

    const oldHashes = db.ProjectContribution._rows[0].changes.map((c) => c.hash).filter(Boolean);
    const now = P.now1.map(([p, c]) => (p === "assets/logo.bin" ? [p, Buffer.from([0, 1, 2, 3, 0, 0, 9, 7])] : [p, c]));
    now.push(["docs/guide.md", "# Guide\n"]); // kept, as asked
    r = await explain("B", P.c1, EXPLAIN + " Kept the guide as asked, and updated the logo.");
    assert.equal(r.status, 200);
    r = await send("B", P.c1, now, ["assets/logo.bin", "src/index.js", "src/util/new.js"]);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.contribution.status, "submitted");
    assert.equal(r.json.contribution.decisionNote, "", "the old reply is cleared");
    assert.deepEqual(r.json.contribution.summary, { added: 1, changed: 2, removed: 0 });
    P.now1 = now;
    assert.ok(oldHashes.length > 0);
});

test("merging: one new version, credited to the contributor, that contains exactly their changes", async () => {
    assert.equal((await call("B", "POST", `/projects/${P.id}/contributions/${P.c1}/decision`, { json: { action: "merge" } })).status, 403);
    const r = await decide(P.c1, "merge", "Thanks!");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.version.number, 2);
    assert.deepEqual([r.json.contribution.status, r.json.contribution.mergedVersion], ["merged", 2]);

    const info = await call("A", "GET", `/projects/${P.id}`);
    assert.equal(info.json.project.latestVersion, 2);
    assert.equal(info.json.project.fileCount, 7 - 0, "v1 had 6, the request added one file and removed none");
    assert.equal(info.json.waitingCount, 0);
    assert.equal((await call("A", "GET", `/projects/${P.id}/file?path=src/index.js`)).json.content, "const GREETING = 'hello';\nconsole.log(GREETING);\n");
    assert.equal((await call("A", "GET", `/projects/${P.id}/file?path=src/index.js&version=1`)).json.content, "console.log('hello');\n", "v1 is untouched");
    assert.equal((await call("A", "GET", `/projects/${P.id}/file?path=package.json`)).json.content, '{"name":"demo"}');

    for (const who of ["A", "B", "E"]) {
        const v = await call(who, "GET", `/projects/${P.id}/versions`);
        assert.equal(v.json.versions[0].number, 2);
        assert.equal(v.json.versions[0].contributor.name, "Bob Dev", who);
        assert.match(v.json.versions[0].message, /Move the greeting into a constant \(by Bob Dev\)/);
        assert.equal(v.json.versions[1].contributor, null);
    }
    assert.equal((await decide(P.c1, "merge")).status, 409, "cannot merge twice");
    assert.equal((await decide(P.c1, "decline", "too late")).status, 409, "a merged request cannot be declined");
    assert.equal((await call("B", "DELETE", `/projects/${P.id}/contributions/${P.c1}`)).status, 409);
    const merged = (await call("A", "GET", `/projects/${P.id}/activity`)).json.activity.find((a) => a.type === "merge");
    assert.deepEqual([merged.target.name, merged.detail.version], ["Bob Dev", 2]);
    // after merging Bob's permission to download is over (he needs a new request for more work)
    assert.equal((await call("B", "GET", `/projects/${P.id}/download`)).status, 403);
});

test("a conflict is caught: if the owner changed the same file meanwhile, nothing is merged", async () => {
    let r = await asks("B", { title: "Log the greeting", intent: "I want to log the greeting with a timestamp so problems are easier to trace in production." });
    assert.equal(r.status, 201);
    P.c2 = r.json.contribution._id;
    await decide(P.c2, "approve");
    await explain("B", P.c2, "Added a timestamp to the log line so that support can tell when the greeting was printed.");
    const v2 = [["package.json", '{"name":"demo"}'], ["src/index.js", "const GREETING = 'hello';\nconsole.log(GREETING);\n"], ["src/util/math.js", "export const add = (a, b) => a + b;\n"], ["src/util/new.js", "export const n = 1;\n"], ["assets/logo.bin", Buffer.from([0, 1, 2, 3, 0, 0, 9, 7])], [".env.example", "TOKEN="], ["docs/guide.md", "# Guide\n"]];
    const bobs = v2.map(([p, c]) => (p === "src/index.js" ? [p, "const GREETING = 'hello';\nconsole.log(new Date(), GREETING);\n"] : [p, c]));
    assert.equal((await send("B", P.c2, bobs, ["src/index.js"], 2)).status, 201);

    // the owner edits the same file and uploads v3
    const owners = v2.map(([p, c]) => (p === "src/index.js" ? [p, "const GREETING = 'hi there';\nconsole.log(GREETING);\n"] : [p, c]));
    r = await call("A", "POST", `/projects/${P.id}/versions?message=Change%20greeting`, { body: deltaZip(owners, ["src/index.js"]) });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.version.number, 3);

    r = await decide(P.c2, "merge");
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "CONFLICT");
    assert.deepEqual(r.json.conflicts, ["src/index.js"]);
    assert.equal((await call("A", "GET", `/projects/${P.id}`)).json.project.latestVersion, 3, "no version was created");
    assert.equal((await call("A", "GET", `/projects/${P.id}/contributions/${P.c2}`)).json.contribution.status, "submitted", "it goes back to waiting, not stuck in the middle");
    P.owners3 = owners;
});

test("after a conflict the author updates their work on the latest version; a double click merges once", async () => {
    assert.equal((await decide(P.c2, "request-changes", "The greeting changed in v3 - please redo this on top of it.")).status, 200);
    const now = P.owners3.map(([p, c]) => (p === "src/index.js" ? [p, "const GREETING = 'hi there';\nconsole.log(new Date(), GREETING);\n"] : [p, c]));
    assert.equal((await explain("B", P.c2, "Redid the timestamp change on top of the new greeting so both changes are kept.")).status, 200);
    assert.equal((await send("B", P.c2, now, ["src/index.js"], 3)).status, 201);
    const [x, y] = await Promise.all([decide(P.c2, "merge"), decide(P.c2, "merge")]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409], "exactly one of two simultaneous merges wins");
    const info = await call("A", "GET", `/projects/${P.id}`);
    assert.equal(info.json.project.latestVersion, 4);
    assert.equal((await call("A", "GET", `/projects/${P.id}/file?path=src/index.js`)).json.content, "const GREETING = 'hi there';\nconsole.log(new Date(), GREETING);\n");
    assert.equal(db.ProjectVersion._rows.filter((v) => v.project === P.id).length, 4, "no duplicate version");
    P.v4 = now;
});

test("declining needs a reason, frees the stored changes, and ends the person's download permission", async () => {
    let r = await asks("B", { title: "Rewrite everything", intent: "I think the whole project should be rewritten in another language because I like it more." });
    P.c3 = r.json.contribution._id;
    assert.equal((await decide(P.c3, "decline")).status, 400);
    await decide(P.c3, "approve");
    assert.equal((await call("B", "GET", `/projects/${P.id}/download`)).status, 200);
    await explain("B", P.c3, "Started rewriting the main file in a different language to see how it would look.");
    const now = P.v4.map(([p, c]) => (p === "package.json" ? [p, '{"name":"rewrite-in-progress"}'] : [p, c]));
    assert.equal((await send("B", P.c3, now, ["package.json"], 4)).status, 201);
    const stored = db.ProjectContribution._rows.find((c) => c._id === P.c3).changes[0].hash;
    assert.equal(await isBlobUsed(stored), true, "a pending change keeps its file safe from cleanup");
    ageBlobs();

    r = await decide(P.c3, "decline", "This is not the direction I want for the project.");
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.contribution.status, r.json.contribution.decisionNote], ["declined", "This is not the direction I want for the project."]);
    assert.equal(db.ProjectContribution._rows.find((c) => c._id === P.c3).changes.length, 0);
    assert.equal(await blobs.hasBlob(stored), false, "the declined change's file was cleaned up");
    assert.equal((await call("B", "GET", `/projects/${P.id}/download`)).status, 403);
    assert.equal((await send("B", P.c3, now, ["package.json"], 4)).status, 409, "no more sending");
    assert.equal((await decide(P.c3, "approve")).status, 409);
    assert.equal((await call("B", "GET", `/projects/${P.id}/contributions/${P.c3}`)).json.contribution.decisionNote, "This is not the direction I want for the project.");
});

test("the author can withdraw; the number of open requests per person is limited", async () => {
    const ids = [];
    for (let i = 1; i <= 3; i++) {
        const r = await asks("B", { title: `Idea number ${i}`, intent: `Idea ${i}: a small improvement that I would like to try, described well enough for you to decide.` });
        assert.equal(r.status, 201, String(i));
        ids.push(r.json.contribution._id);
    }
    const fourth = await asks("B", { title: "Idea number 4", intent: "One request too many, which should be refused until one of the others is finished." });
    assert.equal(fourth.status, 409);
    assert.match(fourth.json.error, /3 requests/);
    assert.equal((await asks("E", { title: "Eve has her own limit", intent: "Nobody else's requests count against Eve, so this one is fine to ask for." })).status, 201);

    assert.equal((await call("A", "DELETE", `/projects/${P.id}/contributions/${ids[0]}`)).status, 403, "only the author withdraws");
    const w = await call("B", "DELETE", `/projects/${P.id}/contributions/${ids[0]}`);
    assert.equal(w.status, 200);
    assert.equal(w.json.contribution.status, "withdrawn");
    assert.equal((await call("B", "DELETE", `/projects/${P.id}/contributions/${ids[0]}`)).status, 409, "already finished");
    assert.equal((await asks("B", { title: "Idea number 4", intent: "Now there is room again because one was withdrawn, so this is accepted." })).status, 201);
    assert.ok((await activityTypes()).includes("withdraw"));
    P.open = ids.slice(1);
});

test("blocking someone ends whatever they had going, and frees what they had sent", async () => {
    // Bob has open requests from the last test; make one of them approved and submitted
    const cid = P.open[0];
    await decide(cid, "approve");
    await explain("B", cid, "Some work that is in progress and that I sent for review to the owner already.");
    assert.equal((await send("B", cid, P.v4.map(([p, c]) => (p === "docs/guide.md" ? [p, "# Guide\n\nMore.\n"] : [p, c])), ["docs/guide.md"], 4)).status, 201);
    const stored = db.ProjectContribution._rows.find((c) => c._id === cid).changes[0].hash;
    ageBlobs();
    assert.equal((await call("A", "PUT", `/projects/${P.id}/access/${U.B}`, { json: { blocked: true } })).status, 200);
    const rows = db.ProjectContribution._rows.filter((c) => c.author === U.B);
    assert.ok(rows.every((c) => !["asking", "approved", "submitted", "changes-requested"].includes(c.status)), "nothing of Bob's is still open");
    assert.equal(rows.find((c) => c._id === cid).status, "declined");
    assert.equal(await blobs.hasBlob(stored), false);
    assert.equal((await call("B", "GET", `/projects/${P.id}/contributions`)).status, 404);
    assert.equal((await call("A", "GET", `/projects/${P.id}/access`)).json.people.find((x) => x.user.name === "Bob Dev").openRequests, 0);
    await call("A", "PUT", `/projects/${P.id}/access/${U.B}`, { json: { blocked: false } });
    // Eve's request is untouched
    assert.equal(db.ProjectContribution._rows.filter((c) => c.author === U.E && c.status === "asking").length, 1);
});

test("notifications: the owner is told about requests waiting; a requester is told about replies until they look", async () => {
    assert.equal((await call(null, "GET", "/project-notifications")).status, 401);
    const empty = await call("D", "GET", "/project-notifications");
    assert.deepEqual([empty.json.count, empty.json.waiting, empty.json.updates], [0, [], []]);

    // Eve's request is still waiting for the owner (Carl's swipe-right is a connection notice, not a project one)
    const projectItems = (res) => res.json.waiting.filter((w) => w.kind !== "connect");
    let r = await call("A", "GET", "/project-notifications");
    assert.equal(projectItems(r).length, 1);
    assert.deepEqual([projectItems(r)[0].kind, projectItems(r)[0].person.name, projectItems(r)[0].projectName, projectItems(r)[0].projectId], ["ask", "Eve Dev", "Demo Project", P.id]);
    assert.deepEqual(r.json.waiting.filter((w) => w.kind === "connect").map((w) => w.person.name), ["Carl Unconnected"]);
    assert.equal(r.json.count, 2);
    assert.equal((await call("E", "GET", "/project-notifications")).json.waiting.length, 0, "only the owner is asked to decide");

    // Bob has replies he has not looked at yet (merged and declined requests)
    r = await call("B", "GET", "/project-notifications");
    assert.equal(r.json.waiting.length, 0);
    assert.ok(r.json.updates.length >= 3);
    const merged = r.json.updates.find((u) => u.status === "merged");
    assert.deepEqual([merged.person.name, merged.projectName, merged.projectId], ["Alice Owner", "Demo Project", P.id]);
    assert.ok(r.json.updates.some((u) => u.status === "declined"));
    assert.equal(r.json.count, r.json.updates.length);

    // a project he can no longer see does not leak through a notification
    await call("A", "PATCH", `/projects/${P.id}`, { json: { visibility: "private" } });
    assert.equal((await call("B", "GET", "/project-notifications")).json.count, 0);
    await call("A", "PATCH", `/projects/${P.id}`, { json: { visibility: "friends" } });
    assert.ok((await call("B", "GET", "/project-notifications")).json.count >= 3);

    // looking at his requests clears them
    assert.equal((await call("B", "GET", `/projects/${P.id}/contributions`)).status, 200);
    assert.equal((await call("B", "GET", "/project-notifications")).json.count, 0);

    // a new request shows up for the owner, newest first, and its answer comes back to Bob
    const ask = await asks("B", { title: "Notify me later", intent: "A request that lets us check that the owner gets told and that the reply comes back." });
    assert.equal(ask.status, 201);
    r = await call("A", "GET", "/project-notifications");
    assert.deepEqual(projectItems(r).map((w) => w.person.name), ["Bob Dev", "Eve Dev"]);
    await decide(ask.json.contribution._id, "decline", "Not right now, thanks.");
    r = await call("A", "GET", "/project-notifications");
    assert.deepEqual(projectItems(r).map((w) => w.person.name), ["Eve Dev"], "a decided request stops nagging the owner");
    r = await call("B", "GET", "/project-notifications");
    assert.deepEqual(r.json.updates.map((u) => [u.title, u.status]), [["Notify me later", "declined"]]);
    await call("B", "GET", `/projects/${P.id}/contributions`);
    assert.equal((await call("B", "GET", "/project-notifications")).json.count, 0);

    // blocked people are not told anything about the project
    const again = await asks("B", { title: "Before the block", intent: "A request that will be declined automatically when the owner blocks this person." });
    assert.equal(again.status, 201);
    await call("A", "PUT", `/projects/${P.id}/access/${U.B}`, { json: { blocked: true } });
    assert.equal((await call("B", "GET", "/project-notifications")).json.count, 0);
    await call("A", "PUT", `/projects/${P.id}/access/${U.B}`, { json: { blocked: false } });
    await call("B", "GET", `/projects/${P.id}/contributions`);
});

test("'download only what changed': a friend gets what is new since the version they have", async () => {
    await call("A", "PATCH", `/projects/${P.id}`, { json: { openDownloads: true } });
    // Eve downloaded v1 earlier; now v4 exists
    let r = await call("E", "GET", `/projects/${P.id}/download?since=1`);
    assert.equal(r.status, 200);
    const out = unzipList(r.buf);
    assert.deepEqual(out.names, ["assets/logo.bin", "src/index.js", "src/util/new.js"], "changed + added files only");
    assert.match(r.headers.get("content-disposition"), /demo-project-v4-changes-since-v1\.zip/);
    assert.equal(db.ProjectAccess._rows.find((g) => g.user === U.E).lastFetchedVersion, 4);
    assert.equal((await call("E", "GET", `/projects/${P.id}/download?since=4`)).status, 400, "since must be older");
    assert.equal((await call("E", "GET", `/projects/${P.id}/download?since=1&version=1`)).status, 400);
    assert.equal((await call("E", "GET", `/projects/${P.id}/download?since=x`)).status, 400);
    assert.equal((await call("E", "GET", `/projects/${P.id}/download?since=3&version=3`)).status, 400);
    // v1 -> v3 removed nothing here (guide.md came back), so no removal list
    assert.ok(!unzipList((await call("E", "GET", `/projects/${P.id}/download?since=1&version=3`)).buf).names.includes("TECHMATES_REMOVED.txt"));
    await call("A", "PATCH", `/projects/${P.id}`, { json: { openDownloads: false } });
});

test("new versions by the owner: 'nothing changed' is refused, a delta is smaller than a full upload, unknown content is refused", async () => {
    const current = P.v4;
    assert.equal((await call("A", "POST", `/projects/${P.id}/versions`, { body: z(current) })).status, 409);
    const changed = current.map(([p, c]) => (p === "package.json" ? [p, '{"name":"demo","version":"2"}'] : [p, c]));
    const delta = deltaZip(changed, ["package.json"]);
    assert.ok(delta.length < z(changed).length);
    const r = await call("A", "POST", `/projects/${P.id}/versions?message=Bump`, { body: delta });
    assert.equal(r.status, 201);
    assert.equal(r.json.version.number, 5);
    assert.deepEqual(r.json.version.summary, { added: 0, changed: 1, removed: 0 });
    const evil = zip.makeZip([manifestOf([["package.json", "x"], ["stolen.txt", "not uploaded"]]), { name: "package.json", data: "x" }]);
    assert.equal((await call("A", "POST", `/projects/${P.id}/versions`, { body: evil })).status, 400);
    assert.equal((await call("A", "GET", `/projects/${P.id}/file?path=package.json&version=99`)).status, 404);
    assert.equal((await call("A", "GET", `/projects/${P.id}/file?path=package.json&version=abc`)).status, 400);
});

test("activity is paginated, newest first", async () => {
    const page1 = await call("A", "GET", `/projects/${P.id}/activity?limit=3`);
    assert.equal(page1.json.activity.length, 3);
    assert.equal(page1.json.hasMore, true);
    const page2 = await call("A", "GET", `/projects/${P.id}/activity?limit=100&before=${page1.json.nextCursor}`);
    const ids = new Set([...page1.json.activity, ...page2.json.activity].map((a) => a._id));
    assert.equal(ids.size, page1.json.activity.length + page2.json.activity.length, "no overlap");
    assert.equal(page2.json.hasMore, false);
    assert.equal((await call("A", "GET", `/projects/${P.id}/activity?before=nope`)).status, 400);
    const types = new Set(await activityTypes());
    for (const t of ["upload", "view", "fetch", "ask", "approve", "decline", "request-changes", "submit", "merge", "withdraw", "block", "unblock"]) assert.ok(types.has(t), t);
});

test("a corrupt or missing stored file never produces a plausible-looking zip", async () => {
    const tree = (await call("A", "GET", `/projects/${P.id}/tree`)).json.files;
    const target = db.ProjectVersion._rows.find((v) => v.project === P.id && v.number === 5).files.find((f) => f.path === "package.json");
    assert.ok(tree.length > 0);
    const file = blobs.blobPath(target.hash);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, original.subarray(0, 3));
    await assert.rejects(async () => {
        const res = await fetch(`${base}/projects/${P.id}/download`, { headers: { "x-test-user": U.A } });
        await res.arrayBuffer();
    });
    fs.unlinkSync(file);
    const r = await call("A", "GET", `/projects/${P.id}/download`);
    assert.equal(r.status, 500);
    assert.match(r.json.error, /missing on the server/);
    fs.writeFileSync(file, original);
    assert.equal((await call("A", "GET", `/projects/${P.id}/download`)).status, 200);
});

test("old versions are pruned once the cap is reached - but never a file somebody's pending change needs", async () => {
    // Eve's request stays open with a change to package.json's neighbour: approve, explain, send
    const eve = db.ProjectContribution._rows.find((c) => c.author === U.E);
    await decide(eve._id, "approve");
    await explain("E", eve._id, "Adding a line to the guide that explains how to run the project locally.");
    const base5 = db.ProjectVersion._rows.find((v) => v.project === P.id && v.number === 5).files;
    const guide5 = base5.find((f) => f.path === "docs/guide.md");
    const eveNow = [["docs/guide.md", "# Guide\n\nRun it locally.\n"]];
    // a full manifest (unchanged files by hash) plus only the changed guide
    const manifest = { name: ".techmates/manifest.json", data: JSON.stringify({ v: 1, files: [...base5.filter((f) => f.path !== "docs/guide.md").map((f) => ({ path: f.path, hash: f.hash })), { path: "docs/guide.md", hash: sha256(Buffer.from(eveNow[0][1])) }] }) };
    const res = await call("E", "POST", `/projects/${P.id}/contributions/${eve._id}/changes?base=5`, { body: zip.makeZip([manifest, { name: "docs/guide.md", data: eveNow[0][1] }]) });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const eveHash = db.ProjectContribution._rows.find((c) => c._id === eve._id).changes[0].hash;
    assert.notEqual(eveHash, guide5.hash);

    const old = LIMITS.MAX_VERSIONS;
    LIMITS.MAX_VERSIONS = 2;
    for (let i = 6; i <= 8; i++) {
        const readme = `readme v${i}`;
        const r = await call("A", "POST", `/projects/${P.id}/versions`, { body: zip.makeZip([manifestOf([["README.txt", readme]]), { name: "README.txt", data: readme }]) });
        assert.equal(r.status, 201, JSON.stringify(r.json));
    }
    LIMITS.MAX_VERSIONS = old;
    assert.deepEqual((await call("A", "GET", `/projects/${P.id}/versions`)).json.versions.map((v) => v.number), [8, 7]);
    assert.equal(db.ProjectVersion._rows.filter((v) => v.number <= 6).length, 0);
    assert.equal((await call("A", "GET", `/projects/${P.id}/file?path=package.json&version=1`)).status, 404, "pruned versions are gone");
    assert.equal(await blobs.hasBlob(eveHash), true, "Eve's pending file survives");
    // and her change can no longer be merged safely (the project moved on) - the owner is told, nothing breaks
    ageBlobs();
    const swept = await sweepOrphanBlobs(isBlobUsed);
    assert.equal(await blobs.hasBlob(eveHash), true, "the sweeper keeps files that pending changes use");
    assert.ok(swept.deleted > 0, "and removes files that nothing uses any more");
    const merge = await decide(eve._id, "merge");
    assert.equal(merge.status, 409);
    assert.equal(merge.json.code, "CONFLICT");
    // a friend whose last copy was a pruned version is told to download everything instead
    await call("A", "PATCH", `/projects/${P.id}`, { json: { openDownloads: true } });
    assert.equal((await call("E", "GET", `/projects/${P.id}/download?since=1`)).status, 404);
    assert.deepEqual(unzipList((await call("E", "GET", `/projects/${P.id}/download`)).buf).names, ["README.txt"]);
    await call("A", "PATCH", `/projects/${P.id}`, { json: { openDownloads: false } });
});

test("editing and deleting a project; deleting frees its files, including pending changes", async () => {
    let r = await call("A", "PATCH", `/projects/${P.id}`, { json: { name: "  Renamed  ", description: "d".repeat(500) } });
    assert.equal(r.status, 200);
    assert.equal(r.json.project.name, "Renamed");
    assert.equal(r.json.project.description.length, 300);
    assert.equal((await call("A", "PATCH", `/projects/${P.id}`, { json: { name: "   " } })).status, 400);
    assert.equal((await call("A", "PATCH", `/projects/${P.id}`, { json: { openDownloads: false } })).json.project.name, "Renamed", "other settings survive");

    ageBlobs();
    r = await call("A", "DELETE", `/projects/${P.id}`);
    assert.equal(r.status, 200);
    for (const m of ["Project", "ProjectVersion", "ProjectAccess", "ProjectActivity", "ProjectContribution"]) assert.equal(db[m]._rows.length, 0, m);
    const swept = await sweepOrphanBlobs(isBlobUsed);
    assert.ok(swept.deleted >= 0);
    assert.equal(blobCount(), 0, "every stored file was freed");
    for (const who of ["B", "E"]) assert.equal((await call(who, "GET", `/projects/${P.id}`)).status, 404);
});

test("stored files younger than the grace period are kept when a project is deleted", async () => {
    const r = await call("A", "POST", "/projects?name=Fresh", { body: z([["a.txt", "fresh content"]]) });
    assert.equal(r.status, 201);
    await call("A", "DELETE", `/projects/${r.json.project._id}`);
    assert.ok(blobCount() > 0, "young blobs survive: a concurrent upload may be about to reuse them");
});

test("the sweeper keeps referenced and young files, removes unreferenced old ones and stale temp files", async () => {
    const r = await call("A", "POST", "/projects?name=Sweep", { body: z([["keep.txt", "referenced content"]]) });
    assert.equal(r.status, 201);
    const orphan = Buffer.from("nobody uses this");
    const orphanHash = sha256(orphan);
    await blobs.putBlob(orphanHash, zlib.deflateRawSync(orphan));
    const shard = path.dirname(blobs.blobPath(orphanHash));
    const tmpFile = path.join(shard, "leftover.tmp");
    fs.writeFileSync(tmpFile, "partial");
    let res = await sweepOrphanBlobs(isBlobUsed);
    assert.deepEqual([res.deleted, res.tmpDeleted], [0, 0], "everything is still young");
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    for (const f of [blobs.blobPath(orphanHash), tmpFile]) fs.utimesSync(f, old, old);
    fs.utimesSync(blobs.blobPath(sha256(Buffer.from("referenced content"))), old, old);
    res = await sweepOrphanBlobs(db.ProjectVersion); // a bare model still works (versions only)
    assert.deepEqual([res.deleted, res.tmpDeleted], [1, 1]);
    assert.equal(await blobs.hasBlob(orphanHash), false);
    assert.equal(await blobs.hasBlob(sha256(Buffer.from("referenced content"))), true, "a file that a version uses is never swept");
    assert.equal((await call("A", "GET", `/projects/${r.json.project._id}/download`)).status, 200);
});
