"use strict";
// Chat: only connected devs can talk, threads are private to the pair, unread counts and the bell, sharing a project.
// Real routes over the fake database.
const test = require("node:test");
const assert = require("node:assert/strict");

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

const chatRoutes = require("../src/routes/chatRoutes");
const projectRoutes = require("../src/routes/projectRoutes");

let server;
let base;
const U = {};
let shared; // one of Ann's projects

test.before(async () => {
    for (const [key, name] of [["A", "Ann"], ["B", "Ben"], ["C", "Cy"], ["D", "Dee"]]) {
        U[key] = (await db.User.create({ name, profilePicture: "https://x/y.png" }))._id;
    }
    await db.ConnectionRequest.create({ fromUserId: U.A, toUserId: U.B, status: "accepted" });
    await db.ConnectionRequest.create({ fromUserId: U.C, toUserId: U.A, status: "accepted" }); // the other direction
    await db.ConnectionRequest.create({ fromUserId: U.D, toUserId: U.A, status: "interested" }); // waiting, not connected
    shared = await db.Project.create({ owner: U.A, name: "Ann's API", visibility: "friends" });
    await db.Project.create({ owner: U.A, name: "Secret thing", visibility: "private" });
    const app = express();
    app.use(express.json());
    app.use("/", chatRoutes);
    app.use("/", projectRoutes);
    server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

async function call(user, method, url, json) {
    const res = await fetch(base + url, { method, headers: { "x-test-user": user || "", ...(json ? { "content-type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined });
    const type = res.headers.get("content-type") || "";
    return { status: res.status, json: type.includes("json") ? await res.json() : null };
}
const send = (from, to, text, extra = {}) => call(from, "POST", `/chats/${to}/messages`, { text, ...extra });
const thread = (me, other, query = "") => call(me, "GET", `/chats/${other}/messages${query}`);
const texts = (r) => r.json.messages.map((m) => m.text);

test("you need to be signed in", async () => {
    assert.equal((await call("", "GET", "/chats")).status, 401);
    assert.equal((await call("", "GET", `/chats/${U.B}/messages`)).status, 401);
    assert.equal((await call("", "POST", `/chats/${U.B}/messages`, { text: "hi" })).status, 401);
});

test("only connected devs can chat: everybody else gets the same 404", async () => {
    for (const other of [U.D, "000000000000000000000fff", "not-an-id", U.A]) {
        const r = await send(U.A, other, "hello?");
        assert.equal(r.status, 404, String(other));
        assert.equal((await thread(U.A, other)).status, 404);
    }
    assert.equal((await send(U.D, U.A, "let me in")).status, 404, "a waiting request is not a connection yet");
    assert.equal(db.Message._rows.length, 0);
});

test("the chat list has your devs, and devs you have not written to sit at the bottom", async () => {
    const r = await call(U.A, "GET", "/chats");
    assert.deepEqual(r.json.chats.map((c) => c.user.name), ["Ben", "Cy"]);
    assert.ok(r.json.chats.every((c) => c.last === null && c.unread === 0));
    assert.equal(r.json.unread, 0);
});

test("sending and reading: both people see the same thread, oldest first", async () => {
    assert.equal((await send(U.A, U.B, "  Hi Ben, got a minute?  ")).status, 201);
    assert.equal((await send(U.B, U.A, "Sure, what's up?")).status, 201);
    assert.equal((await send(U.A, U.B, "```js\nconsole.log(1)\n```")).status, 201);

    const ann = await thread(U.A, U.B);
    assert.deepEqual(texts(ann), ["Hi Ben, got a minute?", "Sure, what's up?", "```js\nconsole.log(1)\n```"], "trimmed, in order");
    assert.equal(ann.json.user.name, "Ben");
    assert.equal(ann.json.hasMore, false);
    assert.deepEqual(texts(await thread(U.B, U.A)), texts(ann));
    assert.deepEqual(texts(await thread(U.C, U.A)), [], "Cy's thread with Ann is separate");
    assert.equal((await thread(U.C, U.B)).status, 404, "Cy and Ben are not connected");
});

test("the list shows the latest message and unread counts, and opening the chat clears them", async () => {
    await send(U.B, U.A, "Also, check this out");
    await send(U.B, U.A, "second one");
    await send(U.A, U.B, "and a note for Ben");
    let list = (await call(U.A, "GET", "/chats")).json;
    assert.equal(list.chats[0].user.name, "Ben", "newest conversation first");
    assert.deepEqual([list.chats[0].unread, list.chats[0].last.text, list.chats[0].last.mine], [2, "and a note for Ben", true]);
    assert.equal(list.unread, 2);
    const ben = (await call(U.B, "GET", "/chats")).json.chats.find((c) => c.user.name === "Ann");
    assert.deepEqual([ben.unread, ben.last.mine], [1, false], "Ben has one unread message, and the last one is not his");

    await thread(U.A, U.B); // Ann opens the conversation
    list = (await call(U.A, "GET", "/chats")).json;
    assert.equal(list.unread, 0);
    assert.equal((await call(U.B, "GET", "/chats")).json.unread, 1, "opening my chat does not read yours");
    await thread(U.B, U.A);
    assert.equal((await call(U.B, "GET", "/chats")).json.unread, 0);
});

test("polling with ?after only returns what is new", async () => {
    const all = await thread(U.A, U.B);
    const lastId = all.json.messages.at(-1)._id;
    assert.deepEqual(texts(await thread(U.A, U.B, `?after=${lastId}`)), []);
    await send(U.B, U.A, "one more");
    const fresh = await thread(U.A, U.B, `?after=${lastId}`);
    assert.deepEqual(texts(fresh), ["one more"]);
    assert.equal((await thread(U.A, U.B, "?after=zzz")).status, 400);
});

test("a message from someone with a stale id cannot leak: ?after only ever reads this pair", async () => {
    const otherPair = await send(U.C, U.A, "private to Cy and Ann");
    const r = await thread(U.A, U.B, `?after=${"0".repeat(24)}`);
    assert.ok(!texts(r).includes("private to Cy and Ann"));
    assert.equal(otherPair.status, 201);
});

test("the Seen mark follows what the other person has opened", async () => {
    const mine = await send(U.A, U.B, "did you see this?");
    assert.equal((await thread(U.A, U.B)).json.seenUpTo === mine.json.message._id, false, "Ben has not opened it yet");
    await thread(U.B, U.A);
    assert.equal((await thread(U.A, U.B)).json.seenUpTo, mine.json.message._id);
});

test("long conversations come in pages, older messages on request", async () => {
    await db.Message._reset();
    const pair = [U.A, U.B].sort().join(":");
    for (let i = 1; i <= 60; i++) await db.Message.create({ pair, from: U.A, to: U.B, text: `m${i}` }); // straight in: the per-minute limit is tested separately
    const latest = await thread(U.A, U.B);
    assert.equal(latest.json.messages.length, 50);
    assert.deepEqual([latest.json.messages[0].text, latest.json.messages.at(-1).text, latest.json.hasMore], ["m11", "m60", true]);
    const older = await thread(U.A, U.B, `?before=${latest.json.messages[0]._id}`);
    assert.deepEqual([older.json.messages[0].text, older.json.messages.at(-1).text, older.json.hasMore], ["m1", "m10", false]);
});

test("rules for what can be sent", async () => {
    await db.Message._reset();
    assert.equal((await send(U.A, U.B, "")).status, 400);
    assert.equal((await send(U.A, U.B, "   \n ")).status, 400);
    assert.equal((await send(U.A, U.B, "x".repeat(10001))).status, 400);
    assert.equal((await send(U.A, U.B, "x".repeat(10000))).status, 201);
    assert.equal((await call(U.A, "POST", `/chats/${U.B}/messages`, { text: 42 })).status, 400);
    assert.equal((await call(U.A, "POST", `/chats/${U.B}/messages`)).status, 400, "no body");
});

test("code is sent whole, and lists and the bell show [code] instead of the code", async () => {
    await db.Message._reset();
    const code = "```js\nconst secret = 1;\nconsole.log(secret);\n```";
    const body = "see this:\n" + code;
    const r = await send(U.A, U.B, body);
    assert.equal(r.status, 201);
    assert.equal(r.json.message.text, body, "stored exactly as sent");
    const big = "```python\n" + "print('x')\n".repeat(600) + "```";
    assert.ok(big.length > 2000 && big.length < 10000);
    assert.equal((await send(U.A, U.B, big)).status, 201);
    const last = (await call(U.B, "GET", "/chats")).json.chats.find((c) => c.user.name === "Ann").last.text;
    assert.equal(last, "[code]");
    const only = await send(U.A, U.B, "look " + code + " done");
    assert.equal(only.status, 201);
    assert.equal((await call(U.B, "GET", "/chats")).json.chats.find((c) => c.user.name === "Ann").last.text, "look [code] done");
    const bell = (await call(U.B, "GET", "/project-notifications")).json.updates.find((u) => u.status === "message");
    assert.equal(bell.preview, "look [code] done");
    assert.ok(!/secret|print/.test(JSON.stringify(bell)));
});

test("emoji are stored as sent and never cut in half in previews", async () => {
    await db.Message._reset();
    const hello = "Hi \u{1F600} \u2764\uFE0F \u{1F469}\u200D\u{1F4BB}";
    const r = await send(U.A, U.B, hello);
    assert.equal(r.status, 201);
    assert.equal(r.json.message.text, hello, "sequences with joiners and variation selectors survive");
    await db.Message._reset();
    const long = "a".repeat(119) + "\u{1F600}" + "b".repeat(20);
    assert.equal((await send(U.A, U.B, long)).status, 201);
    const last = (await call(U.B, "GET", "/chats")).json.chats.find((c) => c.user.name === "Ann").last.text;
    assert.equal(last, "a".repeat(119) + "\u{1F600}", "cut after 120 characters, the emoji whole");
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(last), "no lone surrogate");
    const tight = "a".repeat(120) + "\u{1F600}";
    await send(U.A, U.B, tight);
    assert.equal((await call(U.B, "GET", "/chats")).json.chats.find((c) => c.user.name === "Ann").last.text, "a".repeat(120), "an emoji past the cut is dropped whole");
    const family = "a".repeat(119) + "\u{1F469}\u200D\u{1F4BB}";
    await send(U.A, U.B, family + "zzz");
    assert.equal((await call(U.B, "GET", "/chats")).json.chats.find((c) => c.user.name === "Ann").last.text, family, "a joined emoji counts as one character");
});

test("the html in a message is stored as plain text, untouched", async () => {
    const r = await send(U.A, U.B, "<img src=x onerror=alert(1)>");
    assert.equal(r.json.message.text, "<img src=x onerror=alert(1)>", "the screen prints text as text");
});

test("sharing a project: only your own, only ones your devs can see", async () => {
    const ok = await send(U.A, U.B, "", { projectId: shared._id });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.json.message.project, { _id: shared._id, name: "Ann's API" });
    assert.equal((await thread(U.B, U.A)).json.messages.at(-1).project.name, "Ann's API");
    assert.equal((await call(U.A, "GET", "/chats")).json.chats.find((c) => c.user.name === "Ben").last.text, "Shared Ann's API");

    assert.equal((await send(U.B, U.A, "", { projectId: shared._id })).status, 400, "Ben cannot share Ann's project");
    const priv = db.Project._rows.find((p) => p.name === "Secret thing");
    const hidden = await send(U.A, U.B, "", { projectId: priv._id });
    assert.equal(hidden.status, 400);
    assert.match(hidden.json.error, /hidden from your devs/);
    assert.equal((await send(U.A, U.B, "", { projectId: "nope" })).status, 400);

    await db.ProjectAccess.create({ project: shared._id, user: U.C, status: "blocked" });
    const blocked = await send(U.A, U.C, "", { projectId: shared._id });
    assert.equal(blocked.status, 400);
    assert.match(blocked.json.error, /blocked/);
});

test("the bell tells you about unread messages, once per person, until you open the chat", async () => {
    await db.Message._reset();
    await send(U.B, U.A, "ping");
    await send(U.B, U.A, "ping 2");
    await send(U.C, U.A, "", { projectId: undefined, text: "hello from Cy" });
    const bell = (await call(U.A, "GET", "/project-notifications")).json;
    const msgs = bell.updates.filter((u) => u.status === "message");
    assert.equal(bell.unreadMessages, 3);
    assert.deepEqual(msgs.map((m) => [m.person.name, m.count, m.preview]).sort(), [["Ben", 2, "ping 2"], ["Cy", 1, "hello from Cy"]]);
    assert.ok(bell.count >= 2);

    await thread(U.A, U.B);
    const after = (await call(U.A, "GET", "/project-notifications")).json;
    assert.deepEqual(after.updates.filter((u) => u.status === "message").map((m) => m.person.name), ["Cy"]);
    assert.equal(after.unreadMessages, 1);
    assert.equal((await call(U.B, "GET", "/project-notifications")).json.unreadMessages, 0, "the sender is not told");
});

test("too many messages in a minute are refused", async () => {
    await db.Message._reset();
    for (let i = 0; i < 30; i++) assert.equal((await send(U.A, U.B, `spam ${i}`)).status, 201);
    const r = await send(U.A, U.B, "one too many");
    assert.equal(r.status, 429);
    assert.equal((await send(U.B, U.A, "but Ben is fine")).status, 201, "the limit is per sender");
});
