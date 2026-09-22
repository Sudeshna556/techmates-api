"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const zip = require("../src/utils/zipfile");
const { ingestZip, ProjectError, sha256 } = require("../src/utils/projectIngest");
const files = require("../src/utils/projectFiles");
const { scanText } = require("../src/utils/secretScan");
const blobs = require("../src/utils/blobStore");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-utils-"));
process.env.PROJECT_STORAGE_DIR = path.join(tmp, "store");
const z = (list) => zip.makeZip(list.map(([name, data]) => ({ name, data })));
const fails = (fn, re) => assert.throws(fn, (e) => e instanceof ProjectError && (!re || re.test(e.message)));

// patch helpers: change a field in every central-directory record (and its local header)
function patchCentral(buf, offset, write) {
    const out = Buffer.from(buf);
    let p = out.readUInt32LE(out.length - 22 + 16);
    while (out.readUInt32LE(p) === 0x02014b50) {
        write(out, p + offset);
        p += 46 + out.readUInt16LE(p + 28) + out.readUInt16LE(p + 30) + out.readUInt16LE(p + 32);
    }
    return out;
}

test("path normalisation rejects anything that could escape the project", () => {
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:\\x", "C:/x", "a\u0000b", "", "..", "a/../..", "x".repeat(400)]) {
        assert.equal(files.normalizePath(bad), null, JSON.stringify(bad));
    }
    assert.equal(files.normalizePath("a\\b\\c.js"), "a/b/c.js");
    assert.equal(files.normalizePath("./a//b/./c"), "a/b/c");
    assert.equal(files.normalizePath("src/ünï.js"), "src/ünï.js");
    assert.equal(files.normalizePath(Array(40).fill("d").join("/")), null); // too deep
});

test("scope: prefixes match whole folders only", () => {
    assert.ok(files.inScope("src/a.js", ["src"]));
    assert.ok(files.inScope("src", ["src"]));
    assert.ok(!files.inScope("src2/a.js", ["src"]));
    assert.ok(!files.inScope("a/src/a.js", ["src"]));
    assert.ok(files.inScope("anything", []));
    assert.ok(files.inScope("anything", undefined));
});

test("ignore + secret-name rules", () => {
    assert.equal(files.ignoredBy("node_modules/x/y.js"), "node_modules/");
    assert.equal(files.ignoredBy("a/b/.git/config"), ".git/");
    assert.equal(files.ignoredBy("src/.DS_Store"), ".DS_Store");
    assert.equal(files.ignoredBy("npm-debug.LOG"), "*.log");
    assert.equal(files.ignoredBy("src/node_modules_notes.md"), null); // only whole folder names
    assert.equal(files.ignoredBy("node_modules"), null); // a *file* called node_modules is not the folder
    assert.equal(files.secretFileReason(".env"), "environment file");
    assert.equal(files.secretFileReason("api/.env.production"), "environment file");
    assert.equal(files.secretFileReason(".env.example"), null);
    assert.equal(files.secretFileReason("certs/server.PEM"), "private key / certificate store");
    assert.equal(files.secretFileReason("home/id_rsa"), "credentials file");
    assert.equal(files.secretFileReason("home/id_rsa.pub"), null);
    assert.equal(files.secretFileReason("src/environment.js"), null);
});

test("diffManifests", () => {
    const d = files.diffManifests([{ path: "a", hash: "1" }, { path: "b", hash: "2" }, { path: "c", hash: "3" }], [{ path: "a", hash: "1" }, { path: "b", hash: "9" }, { path: "d", hash: "4" }]);
    assert.deepEqual(d, { added: ["d"], changed: ["b"], removed: ["c"] });
    assert.deepEqual(files.diffManifests(null, [{ path: "a", hash: "1" }]).added, ["a"]);
});

test("secret scanner: finds real secrets, ignores placeholders, never leaks the value", () => {
    const src = [
        'await mongoose.connect("mongodb+srv://SudeshnaDas:Fd5lwmMfJ9AfX38m@cluster-1.rd00r.mongodb.net/techMates");',
        'jwt.verify(token, "sd@123");',
        'const uri = "mongodb://user:<password>@host/db";',
        'const u2 = "postgres://app:${DB_PASS}@db/x";',
        'const k = "AIzaSyA1234567890abcdefghijklmnopqrstuv";',
        'const label = { password: "passwordLabel" };',
        'const s = { clientSecret: "Sup3rSecret!pw" };',
        'placeholder="Enter your password"',
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        'const aws = "AKIAIOSFODNN7EXAMPLE";',
        "const ok = process.env.JWT_SECRET;",
        'token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"',
    ].join("\n");
    const found = scanText("a.js", src);
    assert.deepEqual(found.map((f) => f.line).sort((a, b) => a - b), [1, 2, 5, 7, 9, 10, 12]);
    const dump = JSON.stringify(found);
    for (const secret of ["Fd5lwmMfJ9AfX38m", "sd@123", "Sup3rSecret!pw", "abcdefghijklmnopqrstuvwxyz0123456789", "IOSFODNN7EXAMPLE"]) {
        assert.ok(!dump.includes(secret), `leaked ${secret}`);
    }
});

test("zip writer output is a real zip: unzip -t and python agree, streamed length is exact", async () => {
    const list = [
        { name: "src/index.js", data: "console.log('hi');\n".repeat(100) },
        { name: "readme ünï.md", data: "héllo" },
        { name: "empty", data: "" },
        { name: "bin.dat", data: crypto_random(50000) },
    ];
    const entries = list.map((f) => zip.entryFromBuffer(f.name, f.data, new Date("2026-03-04T05:06:08Z")));
    const plan = zip.planZip(entries);
    const out = path.join(tmp, "stream.zip");
    const ws = fs.createWriteStream(out);
    await zip.streamZip(ws, entries, plan);
    await new Promise((r) => ws.on("close", r));
    assert.equal(fs.statSync(out).size, plan.totalLength);
    execFileSync("unzip", ["-tq", out]);
    const py = execFileSync("python3", ["-c", `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print("|".join(z.namelist()));print(z.getinfo("src/index.js").date_time)`, out]).toString();
    assert.match(py, /src\/index\.js\|readme ünï\.md\|empty\|bin\.dat/);
    assert.match(py, /\(2026, 3, 4, 5, 6, 8\)/);
});
function crypto_random(n) {
    return require("crypto").randomBytes(n);
}

test("streamZip can copy stored blobs from disk without recompressing", async () => {
    const content = Buffer.from("stored once, sent as-is\n".repeat(500));
    const hash = sha256(content);
    const deflated = zlib.deflateRawSync(content);
    assert.equal(await blobs.putBlob(hash, deflated), true);
    assert.equal(await blobs.putBlob(hash, deflated), false); // second time: already there
    const entry = { name: "from-disk.txt", crc: zip.crc32(content), size: content.length, csize: deflated.length, mtime: new Date(), source: { path: blobs.blobPath(hash) } };
    const out = path.join(tmp, "disk.zip");
    const ws = fs.createWriteStream(out);
    await zip.streamZip(ws, [entry]);
    await new Promise((r) => ws.on("close", r));
    execFileSync("unzip", ["-tq", out]);
    assert.equal(execFileSync("unzip", ["-p", out, "from-disk.txt"]).toString(), content.toString());
    // a truncated blob must fail loudly instead of producing a corrupt-but-plausible zip
    fs.truncateSync(blobs.blobPath(hash), 10);
    await assert.rejects(zip.streamZip(fs.createWriteStream(path.join(tmp, "bad.zip")), [entry]), /wrong length/);
});

test("blob store rejects anything that is not a sha-256 (no path tricks)", async () => {
    for (const bad of ["../../etc/passwd", "abc", "G".repeat(64), "", undefined]) assert.throws(() => blobs.blobPath(bad));
});

test("reads zips made by the standard tools (zip CLI and python), dirs, unicode, stored + deflated", () => {
    const dir = path.join(tmp, "proj");
    fs.mkdirSync(path.join(dir, "proj/src/ünï"), { recursive: true });
    fs.mkdirSync(path.join(dir, "proj/node_modules/lib"), { recursive: true });
    fs.writeFileSync(path.join(dir, "proj/package.json"), '{"name":"x"}');
    fs.writeFileSync(path.join(dir, "proj/src/ünï/a.js"), "a".repeat(5000));
    fs.writeFileSync(path.join(dir, "proj/node_modules/lib/x.js"), "x");
    fs.writeFileSync(path.join(dir, "proj/.env"), "TOKEN=1");
    fs.writeFileSync(path.join(dir, "proj/.env.example"), "TOKEN=");
    fs.writeFileSync(path.join(dir, "proj/pic.png"), crypto_random(300));
    const out = path.join(tmp, "cli.zip");
    execFileSync("zip", ["-qr", out, "proj"], { cwd: dir });
    const r = ingestZip(fs.readFileSync(out), null);
    assert.deepEqual(r.files.map((f) => f.path), [".env.example", "package.json", "pic.png", "src/ünï/a.js"]); // wrapper folder stripped
    assert.deepEqual(r.report.skipped, [{ label: "node_modules/", count: 1 }]);
    assert.deepEqual(r.report.excluded, [{ path: ".env", reason: "environment file" }]);
    assert.equal(r.stats.fileCount, 4);
    // python zips (stored + deflated mix)
    const py = path.join(tmp, "py.zip");
    execFileSync("python3", ["-c", `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],"w")
z.writestr("a.txt","stored",compress_type=zipfile.ZIP_STORED)
z.writestr("b/c.txt","deflated "*100,compress_type=zipfile.ZIP_DEFLATED)`, py]);
    const r2 = ingestZip(fs.readFileSync(py), null);
    assert.deepEqual(r2.files.map((f) => [f.path, f.size]), [["a.txt", 6], ["b/c.txt", 900]]);
    // what we store must inflate back to the original content
    for (const f of r2.files) assert.equal(sha256(zlib.inflateRawSync(r2.newBlobs.get(f.hash))), f.hash);
});

test("hostile zips: zip-slip paths are dropped and reported", () => {
    const r = ingestZip(z([["ok.txt", "fine"], ["../evil.txt", "x"], ["/abs.txt", "x"], ["a/../../b.txt", "x"], ["C:\\win.txt", "x"], ["..\\back.txt", "x"]]), null);
    assert.deepEqual(r.files.map((f) => f.path), ["ok.txt"]);
    assert.equal(r.report.unsafe, 5);
});

test("hostile zips: a header that lies about the size cannot make us inflate more", () => {
    const big = z([["a.txt", Buffer.alloc(2 * 1024 * 1024, 0x41)]]);
    const lied = patchCentral(big, 24, (b, p) => b.writeUInt32LE(100, p)); // claim 100 bytes
    fails(() => ingestZip(lied, null), /damaged/);
});

test("hostile zips: honest bombs are refused by size limits", () => {
    const one = z([["huge.bin", Buffer.alloc(30 * 1024 * 1024)]]); // 30 MB of zeros, a few KB zipped
    assert.ok(one.length < 100000);
    const r = ingestZip(z([["huge.bin", Buffer.alloc(30 * 1024 * 1024)], ["ok.txt", "hi"]]), null);
    assert.deepEqual(r.report.tooLarge, ["huge.bin"]); // over the per-file limit -> skipped without inflating
    assert.deepEqual(r.files.map((f) => f.path), ["ok.txt"]);
    const many = z(Array.from({ length: 8 }, (_, i) => [`f${i}.bin`, Buffer.alloc(4 * 1024 * 1024, i)])); // 32 MB total > 25 MB
    fails(() => ingestZip(many, null), /too large/);
    const tooMany = z(Array.from({ length: 2001 }, (_, i) => [`f${i}.txt`, `${i}`]));
    fails(() => ingestZip(tooMany, null), /Too many files/);
});

test("hostile zips: encrypted, wrong crc, exotic compression, garbage, truncated", () => {
    const base = z([["a.txt", "hello hello hello"]]);
    fails(() => ingestZip(patchCentral(base, 8, (b, p) => b.writeUInt16LE(b.readUInt16LE(p) | 1, p)), null), /password/);
    fails(() => ingestZip(patchCentral(base, 16, (b, p) => b.writeUInt32LE(0xdeadbeef, p)), null), /checksum/);
    fails(() => ingestZip(patchCentral(base, 10, (b, p) => b.writeUInt16LE(9, p)), null), /unsupported/);
    fails(() => ingestZip(Buffer.from("this is definitely not a zip file at all"), null), /not a valid zip/);
    fails(() => ingestZip(crypto_random(5000), null), /not a valid zip/);
    fails(() => ingestZip(base.subarray(0, base.length - 30), null), /not a valid zip|damaged/);
    fails(() => ingestZip(Buffer.alloc(0), null), /not a valid zip/);
});

test("a zip with only ignored files says so", () => {
    fails(() => ingestZip(z([["node_modules/a.js", "x"], [".DS_Store", "x"]]), null), /no files to share/);
});

test("secrets found in the upload are reported (masked) but do not block by themselves", () => {
    const r = ingestZip(z([["db.js", 'mongoose.connect("mongodb+srv://u:Fd5lwmMfJ9AfX38m@c.mongodb.net/x")'], ["ok.js", "1"]]), null);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].path, "db.js");
    assert.ok(!JSON.stringify(r).includes("Fd5lwmMfJ9AfX38m") || JSON.stringify(r.findings).indexOf("Fd5lwmMfJ9AfX38m") === -1);
});

// ---- delta mode ----
const manifestOf = (list) => ({ name: ".techmates/manifest.json", data: JSON.stringify({ v: 1, files: list.map(([p, c]) => ({ path: p, hash: sha256(Buffer.from(c)) })) }) });
function v1() {
    return ingestZip(z([["a.txt", "AAA"], ["b.txt", "BBB"], ["dir/c.txt", "CCC"]]), null);
}

test("delta mode: only changed files travel, the rest is reused", () => {
    const first = v1();
    const prev = first.files;
    const upload = zip.makeZip([manifestOf([["a.txt", "AAA"], ["b.txt", "BBB2"], ["dir/c.txt", "CCC"], ["new.txt", "NEW"]]), { name: "b.txt", data: "BBB2" }, { name: "new.txt", data: "NEW" }]);
    const r = ingestZip(upload, prev);
    assert.equal(r.delta, true);
    assert.deepEqual(r.files.map((f) => f.path), ["a.txt", "b.txt", "dir/c.txt", "new.txt"]);
    assert.equal(r.newBlobs.size, 2); // only the 2 that were sent
    assert.deepEqual(r.summary, { added: 1, changed: 1, removed: 0 });
    // reused files keep the server's own size/crc, not anything the client claimed
    const a = r.files.find((f) => f.path === "a.txt");
    assert.deepEqual(a, prev.find((f) => f.path === "a.txt"));
    assert.ok(upload.length < 1500);
});

test("delta mode: deletions and renames", () => {
    const prev = v1().files;
    const r = ingestZip(zip.makeZip([manifestOf([["a.txt", "AAA"], ["renamed/c.txt", "CCC"]])]), prev); // b.txt deleted, c moved (same content)
    assert.deepEqual(r.files.map((f) => f.path), ["a.txt", "renamed/c.txt"]);
    assert.equal(r.newBlobs.size, 0);
    assert.deepEqual(r.summary, { added: 1, changed: 0, removed: 2 });
});

test("delta mode: cannot claim content that was never uploaded, or lie about a fingerprint", () => {
    const prev = v1().files;
    fails(() => ingestZip(zip.makeZip([manifestOf([["a.txt", "AAA"], ["stolen.txt", "someone else's secret"]])]), prev), /missing the content/);
    fails(() => ingestZip(zip.makeZip([{ name: ".techmates/manifest.json", data: JSON.stringify({ files: [{ path: "a.txt", hash: sha256(Buffer.from("X")) }] }) }, { name: "a.txt", data: "not X" }]), prev), /fingerprint/);
    fails(() => ingestZip(zip.makeZip([manifestOf([["../x", "1"]])]), prev), /invalid/);
    fails(() => ingestZip(zip.makeZip([manifestOf([[".env", "1"]]), { name: ".env", data: "1" }]), prev), /invalid/);
    fails(() => ingestZip(zip.makeZip([manifestOf([["node_modules/x.js", "1"]]), { name: "node_modules/x.js", data: "1" }]), prev), /invalid/);
    fails(() => ingestZip(zip.makeZip([{ name: ".techmates/manifest.json", data: JSON.stringify({ files: [{ path: "a.txt", hash: "nothex" }] }) }]), prev), /invalid/);
    fails(() => ingestZip(zip.makeZip([{ name: ".techmates/manifest.json", data: "{not json" }]), prev), /damaged/);
    fails(() => ingestZip(zip.makeZip([manifestOf([["a.txt", "AAA"]])]), null), /no previous version/);
    // duplicate path in the manifest
    fails(() => ingestZip(zip.makeZip([{ name: ".techmates/manifest.json", data: JSON.stringify({ files: [{ path: "a.txt", hash: sha256(Buffer.from("AAA")) }, { path: "a.txt", hash: sha256(Buffer.from("AAA")) }] }) }]), prev), /invalid/);
});

test("delta mode: secrets in NEW content are found, unchanged files are not rescanned", () => {
    const prev = ingestZip(z([["a.txt", "AAA"]]), null).files;
    const r = ingestZip(zip.makeZip([manifestOf([["a.txt", "AAA"], ["c.js", 'const k = "AIzaSyA1234567890abcdefghijklmnopqrstuv";']]), { name: "c.js", data: 'const k = "AIzaSyA1234567890abcdefghijklmnopqrstuv";' }]), prev);
    assert.deepEqual(r.findings.map((f) => f.path), ["c.js", "c.js"].slice(0, r.findings.length));
    assert.ok(r.findings.length >= 1);
});

// ---------------------------------------------------------------------------
// reviewing somebody's changes
// ---------------------------------------------------------------------------
const { diffText } = require("../src/utils/lineDiff");
const { planMerge } = require("../src/utils/contributionMerge");

test("line diff: hunks with context, counts, line numbers", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].join("\n") + "\n";
    const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i", "j", "k", "l", "m"].join("\n") + "\n";
    const d = diffText(before, after);
    assert.deepEqual([d.added, d.removed], [2, 1]);
    assert.equal(d.hunks.length, 2, "the two edits are far enough apart to be separate hunks");
    assert.deepEqual(d.hunks[0].lines.filter((l) => l.t !== " ").map((l) => l.t + l.text), ["-e", "+E"]);
    assert.equal(d.hunks[0].oldStart, 2);
    assert.equal(d.hunks[0].lines.length, 8, "3 lines of context on each side of the change");
    assert.deepEqual(d.hunks[1].lines.filter((l) => l.t === "+").map((l) => l.text), ["m"]);
});

test("line diff: identical, empty, new and removed files, windows line endings", () => {
    assert.deepEqual(diffText("same\n", "same\n"), { added: 0, removed: 0, hunks: [] });
    assert.deepEqual(diffText("a\r\nb\r\n", "a\nb\n"), { added: 0, removed: 0, hunks: [] }, "line ending style alone is not a change");
    const created = diffText("", "one\ntwo\n");
    assert.deepEqual([created.added, created.removed, created.hunks.length], [2, 0, 1]);
    const removed = diffText("one\ntwo\n", "");
    assert.deepEqual([removed.added, removed.removed], [0, 2]);
    assert.deepEqual(diffText("x", "x\n"), { added: 0, removed: 0, hunks: [] }, "a trailing newline is not an extra line");
});

test("line diff: a big rewrite stays fast", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `changed ${i}`).join("\n");
    const t = Date.now();
    const d = diffText(a, b);
    assert.ok(Date.now() - t < 3000);
    assert.deepEqual([d.added, d.removed], [3000, 3000]);
});

test("merge planning: applies changes, and refuses when the same file moved on", () => {
    const f = (path, hash) => ({ path, hash, size: 1, csize: 1, crc: 1 });
    const latest = [f("a.js", "h1"), f("b.js", "h2"), f("c.js", "h3")];
    const change = (kind, path, hash, baseHash) => ({ kind, path, hash, baseHash, size: 9, csize: 9, crc: 9 });

    let r = planMerge(latest, [change("changed", "a.js", "h1x", "h1"), change("added", "d.js", "h4"), change("removed", "c.js", undefined, "h3")]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.files.map((x) => [x.path, x.hash]), [["a.js", "h1x"], ["b.js", "h2"], ["d.js", "h4"]]);
    assert.equal(latest.length, 3, "the input is not modified");

    // the owner changed a.js after the contributor started
    r = planMerge([f("a.js", "h1new"), ...latest.slice(1)], [change("changed", "a.js", "h1x", "h1")]);
    assert.deepEqual([r.ok, r.conflicts], [false, ["a.js"]]);
    // ...but if the owner already made exactly the same change there is nothing to fight about
    assert.equal(planMerge([f("a.js", "h1x"), ...latest.slice(1)], [change("changed", "a.js", "h1x", "h1")]).ok, true);
    // changed a file the owner has since deleted
    assert.deepEqual(planMerge(latest.slice(1), [change("changed", "a.js", "h1x", "h1")]).conflicts, ["a.js"]);
    // removed a file the owner has since edited / removed a file that is already gone (fine)
    assert.deepEqual(planMerge([f("c.js", "h3new")], [change("removed", "c.js", undefined, "h3")]).conflicts, ["c.js"]);
    assert.equal(planMerge([], [change("removed", "c.js", undefined, "h3")]).ok, true);
    // added a file the owner has since created with different content
    assert.deepEqual(planMerge([f("d.js", "other")], [change("added", "d.js", "h4")]).conflicts, ["d.js"]);
    assert.equal(planMerge([f("d.js", "h4")], [change("added", "d.js", "h4")]).ok, true);
    // one conflict spoils the whole merge, nothing is half-applied
    r = planMerge(latest, [change("added", "new.js", "h5"), change("changed", "b.js", "h2x", "WRONG")]);
    assert.equal(r.ok, false);
    assert.equal(r.files, undefined);
});
