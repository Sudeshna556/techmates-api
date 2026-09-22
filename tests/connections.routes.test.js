"use strict";
// Swiping right sends interest: the person waits in your dev list. It becomes a match (connected, both lists) when they
// swipe right on you too or accept. Swiping left only hides them. Real routes over the fake DB.
const test = require("node:test");
const assert = require("node:assert/strict");

const express = require("express");
const { build } = require("./helpers/fakeDb");
const db = build();

function inject(rel, exports) {
    const file = require.resolve(rel);
    require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
}
inject("../src/models/connectionRequest", db.ConnectionRequest);
inject("../src/models/userSchema", db.User);
inject("../src/models/message", db.Message);
for (const m of ["project", "projectVersion", "projectAccess", "projectActivity", "projectContribution"]) {
    inject("../src/models/" + m, db[m[0].toUpperCase() + m.slice(1)]);
}
inject("../src/middlewares/auth", {
    userAuth: async (req, res, next) => {
        const id = req.get("x-test-user");
        const user = id && (await db.User.findById(id));
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        req.user = user;
        next();
    },
});

const followRoutes = require("../src/routes/followRequest");
const userRoutes = require("../src/routes/userRouter");
const projectRoutes = require("../src/routes/projectRoutes");
const chatRoutes = require("../src/routes/chatRoutes");

let server;
let base;
const U = {};

test.before(async () => {
    for (const [key, name] of [["A", "Ann"], ["B", "Ben"], ["C", "Cy"], ["D", "Dee"]]) {
        U[key] = (await db.User.create({ name, profilePicture: "https://x/y.png", about: name + " codes", Skills: ["Node.js"] }))._id;
    }
    const app = express();
    app.use(express.json());
    app.use("/", followRoutes);
    app.use("/", userRoutes);
    app.use("/", projectRoutes); // the bell
    app.use("/", chatRoutes);
    server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

async function call(user, method, url, body) {
    const opts = { method, headers: { "x-test-user": user } };
    if (body !== undefined) {
        opts.headers["content-type"] = "application/json";
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(base + url, opts);
    const type = res.headers.get("content-type") || "";
    return { status: res.status, json: type.includes("json") ? await res.json() : { message: await res.text() } };
}
const names = (list) => list.map((u) => u.name);

const feedNames = async (user) => { const r = await call(user, "GET", "/feed?limit=20"); if (!Array.isArray(r.json)) throw new Error("feed: " + JSON.stringify(r)); return r.json.map((u) => u.name); };
const bell = async (user) => (await call(user, "GET", "/project-notifications")).json;

test("swiping right sends interest: they wait in your list, nothing is connected yet", async () => {
    const swipe = await call(U.A, "POST", `/send/request/interested/${U.B}`);
    assert.equal(swipe.status, 200);
    assert.equal(swipe.json.matched, false);

    const ann = (await call(U.A, "GET", "/my-connections")).json;
    assert.deepEqual(names(ann.data), [], "not connected");
    assert.deepEqual(names(ann.pending), ["Ben"], "but waiting in the list");
    assert.deepEqual(names((await call(U.B, "GET", "/my-connections")).json.data), []);
    assert.equal((await call(U.A, "GET", `/user/${U.B}`)).status, 404, "waiting is not access");
    assert.equal((await call(U.B, "GET", `/user/${U.A}`)).status, 404);
    assert.ok(!(await feedNames(U.A)).includes("Ben"), "Ann no longer sees Ben in her feed");
});

test("the person is told, and sees the admirer first in their feed", async () => {
    const n = await bell(U.B);
    assert.equal(n.count, 1);
    assert.equal(n.waiting[0].kind, "connect");
    assert.equal(n.waiting[0].person.name, "Ann");
    assert.equal((await bell(U.A)).count, 0, "the sender is not told about their own swipe");

    const feed = (await call(U.B, "GET", "/feed?limit=20")).json;
    assert.equal(feed[0].name, "Ann");
    assert.equal(feed[0].likedYou, true);
    assert.equal(feed.filter((u) => u.name === "Ann").length, 1, "only once");
    assert.ok(feed.slice(1).every((u) => !u.likedYou));
    assert.equal((await call(U.B, "GET", "/user/received/requests")).json.data.length, 1, "and can accept from the Requests list");
});

test("swiping right back is a match: both are connected, and the first swiper is told", async () => {
    const back = await call(U.B, "POST", `/send/request/interested/${U.A}`);
    assert.equal(back.status, 200);
    assert.equal(back.json.matched, true);
    assert.match(back.json.message, /It's a match/);

    assert.deepEqual(names((await call(U.B, "GET", "/my-connections")).json.data), ["Ann"]);
    assert.equal((await call(U.B, "GET", `/user/${U.A}`)).status, 200);
    assert.equal((await bell(U.B)).count, 0, "nothing left to answer");

    // Ann has not opened her list yet: her bell says it's a match
    const n = await bell(U.A);
    assert.equal(n.count, 1);
    assert.equal(n.updates[0].status, "matched");
    assert.equal(n.updates[0].person.name, "Ben");
    // once she looks at her list, the notice clears and Ben is connected
    const ann = (await call(U.A, "GET", "/my-connections")).json;
    assert.deepEqual(names(ann.data), ["Ben"]);
    assert.deepEqual(names(ann.pending), []);
    assert.equal((await bell(U.A)).count, 0);
    assert.equal(db.ConnectionRequest._rows.length, 1);
});

test("accepting from the Requests list is also a match, and tells the sender", async () => {
    await call(U.A, "POST", `/send/request/interested/${U.C}`);
    const reqId = (await call(U.C, "GET", "/user/received/requests")).json.data[0]._id;
    assert.equal((await call(U.C, "POST", `/request/review/accepted/${reqId}`)).status, 200);
    assert.deepEqual(names((await call(U.A, "GET", "/my-connections")).json.data).sort(), ["Ben", "Cy"]);
    // (A's list was just fetched, so the notice is already cleared) - a second accept path for a fresh sender:
    await call(U.D, "POST", `/send/request/interested/${U.B}`);
    const id2 = (await call(U.B, "GET", "/user/received/requests")).json.data[0]._id;
    await call(U.B, "POST", `/request/review/accepted/${id2}`);
    assert.equal((await bell(U.D)).updates[0].status, "matched");
});

test("declining, or swiping left on someone who swiped right, turns them down and clears the waiting entry", async () => {
    await db.ConnectionRequest._reset();
    await call(U.A, "POST", `/send/request/interested/${U.B}`);
    await call(U.C, "POST", `/send/request/interested/${U.B}`);
    const rows = (await call(U.B, "GET", "/user/received/requests")).json.data;
    const of = (name) => rows.find((r) => r.fromUserId.name === name)._id;

    assert.equal((await call(U.B, "POST", `/request/review/rejected/${of("Cy")}`)).status, 200);
    const skip = await call(U.B, "POST", `/send/request/ignored/${U.A}`);
    assert.equal(skip.status, 200);
    assert.equal(skip.json.matched, false);

    for (const who of [U.A, U.C]) {
        const list = (await call(who, "GET", "/my-connections")).json;
        assert.deepEqual([names(list.data), names(list.pending)], [[], []]);
    }
    assert.equal((await bell(U.B)).count, 0);
    const feed = await feedNames(U.B);
    assert.ok(!feed.includes("Ann") && !feed.includes("Cy"), "turned-down people do not come back");
});

test("swiping left never lists or connects the person", async () => {
    await db.ConnectionRequest._reset();
    await call(U.A, "POST", `/send/request/ignored/${U.D}`);
    const ann = (await call(U.A, "GET", "/my-connections")).json;
    assert.deepEqual([names(ann.data), names(ann.pending)], [[], []]);
    assert.equal((await call(U.D, "GET", "/user/received/requests")).json.data.length, 0);
    assert.equal((await bell(U.D)).count, 0);
    assert.ok(!(await feedNames(U.A)).includes("Dee"));
    // Ann skipped Dee earlier; swiping right on Dee afterwards is refused, not a match
    assert.equal((await call(U.A, "POST", `/send/request/interested/${U.D}`)).status, 400);
});

test("swiping twice, or on someone you are already connected with, is refused", async () => {
    await db.ConnectionRequest._reset();
    assert.equal((await call(U.A, "POST", `/send/request/interested/${U.B}`)).status, 200);
    assert.equal((await call(U.A, "POST", `/send/request/interested/${U.B}`)).status, 400);
    await call(U.B, "POST", `/send/request/interested/${U.A}`); // match
    const again = await call(U.A, "POST", `/send/request/interested/${U.B}`);
    assert.equal(again.status, 400);
    assert.match(again.json.message, /already connected/);
});

test("pronouns travel with the person wherever their card or profile is shown, and only those", async () => {
    await db.ConnectionRequest._reset();
    const ann = db.User._rows.find((u) => u._id === U.A);
    const ben = db.User._rows.find((u) => u._id === U.B);
    ann.pronouns = "she/her";
    ann.gender = "Female";
    ann.email = "ann@example.com";
    ann.password = "hash";
    ben.pronouns = "he/him";

    // the feed (a swipe card), and the same card for an admirer
    const feed = (await call(U.C, "GET", "/feed?limit=20")).json;
    assert.equal(feed.find((u) => u.name === "Ann").pronouns, "she/her");
    assert.equal(feed.find((u) => u.name === "Dee").pronouns, undefined, "nothing invented for people who did not choose any");
    assert.ok(feed.every((u) => u.email === undefined && u.password === undefined), "and nothing private comes with it");

    await call(U.A, "POST", `/send/request/interested/${U.C}`);
    assert.equal((await call(U.C, "GET", "/feed?limit=20")).json[0].pronouns, "she/her");
    assert.equal((await call(U.C, "GET", "/user/received/requests")).json.data[0].fromUserId.pronouns, "she/her", "the Requests list");
    assert.equal((await call(U.A, "GET", "/my-connections")).json.pending[0].pronouns, undefined, "Cy chose none");

    // connected: the profile page and the lists
    await call(U.A, "POST", `/send/request/interested/${U.B}`);
    await call(U.B, "POST", `/send/request/interested/${U.A}`); // match
    const mine = (await call(U.B, "GET", "/my-connections")).json.data;
    assert.equal(mine[0].pronouns, "she/her");
    const profile = (await call(U.B, "GET", `/user/${U.A}`)).json.data;
    assert.deepEqual([profile.pronouns, profile.gender], ["she/her", "Female"]);
    assert.equal(profile.email, undefined);
    assert.equal(profile.password, undefined);
});

test("contact email and profile links are shown to connected devs only, never on cards or lists", async () => {
    await db.ConnectionRequest._reset();
    const ann = db.User._rows.find((u) => u._id === U.A);
    Object.assign(ann, { contactEmail: "ann@example.com", github: "https://github.com/annlee", leetcode: "https://leetcode.com/u/ann_lee/" });

    // strangers: the feed card, the Requests list and the waiting list carry none of it
    const feed = (await call(U.C, "GET", "/feed?limit=20")).json;
    assert.ok(feed.every((u) => u.contactEmail === undefined && u.github === undefined && u.leetcode === undefined), "swipe cards");
    assert.equal((await call(U.C, "GET", `/user/${U.A}`)).status, 404, "not connected: no profile page at all");
    await call(U.A, "POST", `/send/request/interested/${U.C}`);
    const asked = JSON.stringify((await call(U.C, "GET", "/user/received/requests")).json);
    assert.ok(!/ann@example|githubcom|github\.com|leetcode/.test(asked), "the Requests list");
    assert.ok(!/ann@example|github\.com|leetcode/.test(JSON.stringify((await call(U.A, "GET", "/my-connections")).json)), "lists");

    // connected: the profile page has them
    await call(U.C, "POST", `/send/request/interested/${U.A}`); // match
    const profile = (await call(U.C, "GET", `/user/${U.A}`)).json.data;
    assert.deepEqual([profile.contactEmail, profile.github, profile.leetcode], ["ann@example.com", "https://github.com/annlee", "https://leetcode.com/u/ann_lee/"]);
    assert.equal(profile.email, undefined, "the login email stays private");
    assert.equal(profile.password, undefined);
    assert.ok(!/ann@example|github\.com|leetcode/.test(JSON.stringify((await call(U.C, "GET", "/my-connections")).json)), "the connections list stays light");
});

test("unfollowing removes the connection for both sides, and revokes chat and project access", async () => {
    await db.ConnectionRequest._reset();
    await db.Message._reset();
    await call(U.A, "POST", `/send/request/interested/${U.B}`);
    await call(U.B, "POST", `/send/request/interested/${U.A}`); // match: Ann and Ben are connected
    assert.equal((await call(U.A, "GET", `/user/${U.B}`)).status, 200, "connected: profile reachable");
    assert.equal((await call(U.A, "POST", `/chats/${U.B}/messages`, { text: "hi" })).status, 201, "connected: chat works");

    const unrelated = await call(U.C, "DELETE", `/connections/${U.B}`);
    assert.equal(unrelated.status, 404, "someone not connected to Ben cannot unfollow him");

    const gone = await call(U.A, "DELETE", `/connections/${U.B}`);
    assert.equal(gone.status, 200);
    assert.match(gone.json.message, /unfollowed Ben/);

    assert.deepEqual(names((await call(U.A, "GET", "/my-connections")).json.data), [], "gone from Ann's list");
    assert.deepEqual(names((await call(U.B, "GET", "/my-connections")).json.data), [], "and from Ben's list too - it is mutual");
    assert.equal((await call(U.A, "GET", `/user/${U.B}`)).status, 404, "profile no longer reachable");
    assert.equal((await call(U.B, "GET", `/user/${U.A}`)).status, 404, "neither direction");
    assert.equal((await call(U.A, "GET", `/chats/${U.B}`)).status, 404, "chat is closed");
    assert.equal((await call(U.A, "POST", `/chats/${U.B}/messages`, { text: "still here?" })).status, 404, "cannot send either");
    assert.ok((await feedNames(U.A)).includes("Ben"), "Ben is back in Ann's feed, so a fresh swipe can reconnect them");

    // unfollowing someone you are not connected with, or an unknown id, is a plain 404
    const notConnected = await call(U.A, "DELETE", `/connections/${U.D}`);
    assert.equal(notConnected.status, 404);
    const bogus = await call(U.A, "DELETE", "/connections/not-an-id");
    assert.equal(bogus.status, 404);

    // they can reconnect afterwards like any two new devs
    await call(U.A, "POST", `/send/request/interested/${U.B}`);
    await call(U.B, "POST", `/send/request/interested/${U.A}`);
    assert.deepEqual(names((await call(U.A, "GET", "/my-connections")).json.data), ["Ben"], "reconnected");
});
