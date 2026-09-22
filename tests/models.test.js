"use strict";
// Uses the REAL Mongoose models (no database connection needed) to check the schemas accept
// what the routes write, reject bad data, and that every query filter the routes use is legal.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Project = require("../src/models/project");
const ProjectVersion = require("../src/models/projectVersion");
const ProjectAccess = require("../src/models/projectAccess");
const ProjectActivity = require("../src/models/projectActivity");
const ProjectContribution = require("../src/models/projectContribution");

const id = () => new mongoose.Types.ObjectId();
const INTENT = "The login page redirects to a blank screen; I want to fix the redirect and add a test.";
const EXPLAIN = "Changed the redirect to use the stored return path, because the old one dropped it.";

test("schemas accept what the routes write and reject nonsense", () => {
    assert.equal(new Project({ owner: id(), name: "Demo" }).validateSync(), undefined);
    assert.equal(new Project({ owner: id(), name: "Demo" }).visibility, "friends", "friends can see a project unless the owner hides it");
    assert.equal(new Project({ owner: id(), name: "Demo" }).openDownloads, false, "downloading needs approval by default");
    assert.equal(new Project({ owner: id(), name: "Demo", visibility: "private", openDownloads: true }).validateSync(), undefined);
    assert.ok(new Project({ owner: id(), name: "Demo", visibility: "public" }).validateSync(), "no public projects");
    assert.ok(new Project({ owner: id(), name: "" }).validateSync());
    assert.ok(new Project({ owner: id(), name: "x".repeat(61) }).validateSync());
    assert.ok(new Project({ name: "no owner" }).validateSync());

    const file = { path: "a.js", hash: "a".repeat(64), size: 1, csize: 2, crc: 3 };
    assert.equal(new ProjectVersion({ project: id(), number: 1, files: [file] }).validateSync(), undefined);
    assert.equal(new ProjectVersion({ project: id(), number: 2, files: [file], contributedBy: id(), contribution: id() }).validateSync(), undefined);
    assert.ok(new ProjectVersion({ project: id(), number: 1, files: [{ path: "a" }] }).validateSync());

    const ok = { project: id(), user: id() };
    assert.equal(new ProjectAccess(ok).validateSync(), undefined);
    assert.equal(new ProjectAccess(ok).status, "active");
    assert.equal(new ProjectAccess({ ...ok, status: "blocked", blockedAt: new Date() }).validateSync(), undefined);
    assert.ok(new ProjectAccess({ ...ok, status: "pending" }).validateSync());

    for (const type of ["upload", "view", "fetch", "block", "unblock", "ask", "approve", "decline", "request-changes", "submit", "merge", "withdraw"]) {
        assert.equal(new ProjectActivity({ project: id(), actor: id(), type }).validateSync(), undefined, type);
    }
    for (const type of ["hack", "invite", "revoke"]) assert.ok(new ProjectActivity({ project: id(), actor: id(), type }).validateSync(), `${type} is not an event any more`);
});

test("contribution schema: a proper explanation is required up front, states are fixed", () => {
    const ok = { project: id(), author: id(), title: "Fix login redirect", intent: INTENT };
    assert.equal(new ProjectContribution(ok).validateSync(), undefined);
    assert.equal(new ProjectContribution(ok).status, "asking");
    assert.ok(new ProjectContribution({ ...ok, title: "hi" }).validateSync(), "title too short");
    assert.ok(new ProjectContribution({ ...ok, intent: "please" }).validateSync(), "intent too short");
    assert.ok(new ProjectContribution({ ...ok, intent: "x".repeat(1501) }).validateSync(), "intent too long");
    assert.ok(new ProjectContribution({ ...ok, status: "done" }).validateSync());
    for (const status of ["asking", "approved", "submitted", "merging", "changes-requested", "merged", "declined", "withdrawn"]) {
        assert.equal(new ProjectContribution({ ...ok, status }).validateSync(), undefined, status);
    }
    const change = { path: "src/a.js", kind: "changed", hash: "b".repeat(64), size: 3, csize: 5, crc: 7, baseHash: "a".repeat(64) };
    assert.equal(new ProjectContribution({ ...ok, explanation: EXPLAIN, changes: [change, { path: "gone.js", kind: "removed", baseHash: "c".repeat(64) }] }).validateSync(), undefined);
    assert.ok(new ProjectContribution({ ...ok, changes: [{ path: "a", kind: "renamed" }] }).validateSync());
});

test("indexes: one record per person per project, one version number per project, activity expires", () => {
    const has = (Model, keys, unique) => Model.schema.indexes().some(([spec, opts]) => JSON.stringify(spec) === JSON.stringify(keys) && Boolean(opts && opts.unique) === Boolean(unique));
    assert.ok(has(ProjectAccess, { project: 1, user: 1 }, true));
    assert.ok(has(ProjectVersion, { project: 1, number: 1 }, true));
    assert.ok(has(ProjectVersion, { "files.hash": 1 }, false));
    assert.ok(has(ProjectContribution, { "changes.hash": 1 }, false), "stored files needed by pending changes can be looked up");
    assert.ok(has(ProjectContribution, { project: 1, status: 1, createdAt: -1 }, false));
    const ttl = ProjectActivity.schema.indexes().find(([spec]) => spec.at === 1);
    assert.ok(ttl && ttl[1].expireAfterSeconds === 90 * 24 * 60 * 60, "the log expires after 90 days");
});

test("every filter the routes send to Mongo is legal and casts cleanly", () => {
    const a = id().toString();
    const cast = (Model, filter) => Model.find(filter).cast(Model);
    assert.doesNotThrow(() => cast(ProjectAccess, { project: a, user: a }));
    assert.doesNotThrow(() => cast(ProjectAccess, { user: a, project: { $in: [a, a] } }));
    assert.doesNotThrow(() => cast(ProjectAccess, { project: a, user: { $in: [a] } }));
    assert.doesNotThrow(() => cast(Project, { owner: { $in: [a] }, visibility: { $ne: "private" } }));
    assert.doesNotThrow(() => cast(ProjectVersion, { project: a, number: { $lte: 3 } }));
    assert.doesNotThrow(() => cast(ProjectVersion, { "files.hash": "a".repeat(64) }));
    assert.doesNotThrow(() => cast(ProjectContribution, { "changes.hash": "a".repeat(64) }));
    assert.doesNotThrow(() => cast(ProjectContribution, { project: a, author: a, status: { $in: ["asking", "approved"] } }));
    assert.doesNotThrow(() => cast(ProjectContribution, { _id: a, status: "submitted" }));
    assert.doesNotThrow(() => cast(ProjectActivity, { project: a, actor: a, type: "view", "detail.path": "src/a.js", at: { $gt: new Date() } }));
    assert.doesNotThrow(() => cast(ProjectActivity, { project: a, _id: { $lt: a } }));
    const casted = cast(ProjectAccess, { project: a });
    assert.ok(casted.project instanceof mongoose.Types.ObjectId, "string ids are cast to ObjectIds");
    assert.throws(() => cast(ProjectActivity, { _id: { $lt: "not-an-id" } }), "a bad cursor is rejected before it reaches the database (the route also checks)");
});

test("chat message schema: needs a pair and two people, text is capped, unread by default", () => {
    const Message = require("../src/models/message");
    const ok = { pair: `${id()}:${id()}`, from: id(), to: id(), text: "hi" };
    assert.equal(new Message(ok).validateSync(), undefined);
    assert.equal(new Message(ok).readAt, null, "unread until the receiver opens the chat");
    assert.equal(new Message({ ...ok, text: "" }).validateSync(), undefined, "a shared project needs no text");
    assert.equal(new Message({ ...ok, text: undefined, project: id(), projectName: "Demo" }).validateSync(), undefined);
    assert.ok(new Message({ ...ok, text: "x".repeat(10001) }).validateSync(), "10000 characters at most");
    for (const missing of ["pair", "from", "to"]) assert.ok(new Message({ ...ok, [missing]: undefined }).validateSync(), missing);
    // the filters the chat routes send
    const cast = (filter) => Message.find(filter).cast(Message);
    assert.doesNotThrow(() => cast({ pair: ok.pair, _id: { $gt: String(id()) } }));
    assert.doesNotThrow(() => cast({ pair: ok.pair, to: String(id()), readAt: null }));
    assert.doesNotThrow(() => cast({ pair: ok.pair, from: String(id()), readAt: { $ne: null } }));
});

test("user profile: gender and pronouns are optional, from a fixed list, and can be removed again", () => {
    const User = require("../src/models/userSchema");
    const { applyProfileEdits, validateEditProfileData } = require("../src/utils/validations");
    const base = { name: "Ann Lee", email: "ann@example.com", password: "Secret#123" };

    assert.equal(new User(base).validateSync(), undefined, "both are optional");
    for (const pronouns of ["she/her", "he/him", "they/them"]) {
        assert.equal(new User({ ...base, pronouns }).validateSync(), undefined, pronouns);
    }
    for (const gender of ["Male", "Female", "Other"]) assert.equal(new User({ ...base, gender }).validateSync(), undefined, gender);
    assert.ok(new User({ ...base, pronouns: "it/its" }).validateSync().errors.pronouns, "only the fixed list");
    assert.ok(new User({ ...base, gender: "robot" }).validateSync().errors.gender);
    assert.ok(new User({ ...base, pronouns: "" }).validateSync().errors.pronouns, "an empty string is not a value; it has to be removed instead");

    // what the edit route does with the form: fill them in, then clear them with "" or null
    const user = new User(base);
    applyProfileEdits(user, { gender: "Female", pronouns: "she/her", about: "Hi" });
    assert.deepEqual([user.gender, user.pronouns, user.about], ["Female", "she/her", "Hi"]);
    assert.equal(user.validateSync(), undefined);
    applyProfileEdits(user, { gender: "", pronouns: null });
    assert.deepEqual([user.gender, user.pronouns, user.about], [undefined, undefined, "Hi"], "cleared, the rest untouched");
    assert.equal(user.validateSync(), undefined, "and still valid");
    assert.ok(!Object.keys(user.toObject()).includes("pronouns"), "nothing left stored");
    applyProfileEdits(user, { name: "" });
    assert.equal(user.name, "", "other fields are copied as sent (the schema still refuses them on save)");
    assert.ok(user.validateSync().errors.name);

    assert.equal(validateEditProfileData({ body: { pronouns: "he/him", gender: "Male" } }), true, "the edit form may send them");
    assert.equal(validateEditProfileData({ body: { pronouns: "he/him", isAdmin: true } }), false, "but nothing else new");
});

test("user profile: contact email, GitHub and LeetCode are optional, stored in one canonical form, and can be removed", () => {
    const User = require("../src/models/userSchema");
    const { applyProfileEdits, validateEditProfileData } = require("../src/utils/validations");
    const base = { name: "Ann Lee", email: "login@example.com", password: "Secret#123" };

    assert.equal(new User(base).validateSync(), undefined, "all optional");
    const full = { ...base, contactEmail: "Ann.Lee@Example.com ", github: "https://github.com/annlee", leetcode: "https://leetcode.com/u/ann_lee/" };
    const ann = new User(full);
    assert.equal(ann.validateSync(), undefined);
    assert.equal(ann.contactEmail, "ann.lee@example.com", "lower-cased and trimmed");
    assert.ok(new User({ ...base, contactEmail: "not an email" }).validateSync().errors.contactEmail);
    assert.ok(new User({ ...base, github: "annlee" }).validateSync().errors.github, "the schema only takes the canonical link (the route turns usernames into links)");
    assert.ok(new User({ ...base, github: "javascript:alert(1)" }).validateSync().errors.github);
    assert.ok(new User({ ...base, github: "https://evil.com/annlee" }).validateSync().errors.github);
    assert.ok(new User({ ...base, leetcode: "https://leetcode.com/problems/two-sum" }).validateSync().errors.leetcode);
    assert.ok(new User({ ...base, contactEmail: "" }).validateSync().errors.contactEmail, "an empty string must be removed instead");

    // what the edit route does with the form
    const user = new User(base);
    applyProfileEdits(user, { contactEmail: "  Ann@Example.com ", github: "annlee", leetcode: "leetcode.com/ann_lee", about: "Hi" });
    assert.deepEqual([user.contactEmail, user.github, user.leetcode, user.about], ["ann@example.com", "https://github.com/annlee", "https://leetcode.com/u/ann_lee/", "Hi"]);
    assert.equal(user.validateSync(), undefined);
    applyProfileEdits(user, { github: "https://github.com/annlee/some-repo" });
    assert.equal(user.github, "https://github.com/annlee", "a repository link is cut back to the profile");
    applyProfileEdits(user, { contactEmail: "", github: "", leetcode: null });
    assert.deepEqual([user.contactEmail, user.github, user.leetcode, user.about], [undefined, undefined, undefined, "Hi"], "cleared, the rest untouched");
    assert.equal(user.validateSync(), undefined);
    assert.ok(!Object.keys(user.toObject()).some((k) => ["contactEmail", "github", "leetcode"].includes(k)), "nothing left stored");

    for (const bad of [{ github: "https://evil.com/x" }, { github: "javascript:alert(1)" }, { leetcode: "https://github.com/x" }, { leetcode: "https://leetcode.com/problems/two-sum" }, { github: 42 }]) {
        assert.throws(() => applyProfileEdits(new User(base), bad), /not a valid (GitHub|LeetCode) profile link/, JSON.stringify(bad));
    }
    assert.equal(validateEditProfileData({ body: { contactEmail: "a@b.co", github: "x", leetcode: "y" } }), true);
});
