"use strict";
// A small, dependency-free zip reader and writer (Node built-ins only).
//
// Reading is defensive: everything comes from the central directory, sizes are
// enforced while inflating (a lying header can't make us allocate more), CRCs are
// checked, and encrypted / zip64 / exotic-compression archives are refused.
//
// Writing reuses raw-deflate data that is already compressed (that is how the blob
// store keeps files), so a download never has to recompress anything.

const fs = require("fs");
const zlib = require("zlib");
const { once } = require("events");

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

class ZipError extends Error {
    constructor(message) {
        super(message);
        this.name = "ZipError";
    }
}

// --- crc32 ---------------------------------------------------------------
let crcTable = null;
function crc32Fallback(buf, prev = 0) {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let c = ~prev >>> 0;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
}
const crc32 = typeof zlib.crc32 === "function" ? (buf, prev = 0) => zlib.crc32(buf, prev) >>> 0 : crc32Fallback;

// --- reading ---------------------------------------------------------------

/**
 * Lists the entries of a zip held in memory (nothing is inflated yet).
 * @returns {Array<{name, isDir, isSymlink, encrypted, method, crc, csize, size, dataStart}>}
 */
function readZip(buf, { maxEntries = 20000 } = {}) {
    if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError("That is not a valid zip file");

    // the end-of-central-directory record sits at the very end (followed by an optional comment)
    let eocd = -1;
    const lowest = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= lowest; i--) {
        if (buf.readUInt32LE(i) === SIG_EOCD) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new ZipError("That is not a valid zip file");

    const total = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        throw new ZipError("Zip64 archives are not supported - please use a smaller zip");
    }
    if (total > maxEntries) throw new ZipError(`The zip has too many files (max ${maxEntries})`);
    if (cdOffset + cdSize > eocd) throw new ZipError("The zip file is damaged");

    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < total; i++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError("The zip file is damaged");
        const madeBy = buf.readUInt16LE(p + 4);
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const csize = buf.readUInt32LE(p + 20);
        const size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const externalAttrs = buf.readUInt32LE(p + 38);
        const localOffset = buf.readUInt32LE(p + 42);
        if (csize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
            throw new ZipError("Zip64 archives are not supported - please use a smaller zip");
        }
        if (p + 46 + nameLen + extraLen + commentLen > buf.length) throw new ZipError("The zip file is damaged");
        const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;

        // where the data begins comes from the *local* header (its name/extra lengths can differ)
        if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new ZipError("The zip file is damaged");
        const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
        if (dataStart + csize > buf.length) throw new ZipError("The zip file is damaged");

        const unixMode = madeBy >> 8 === 3 ? externalAttrs >>> 16 : 0;
        entries.push({
            name,
            isDir: name.endsWith("/") || (externalAttrs & 0x10) !== 0,
            isSymlink: (unixMode & 0xf000) === 0xa000,
            encrypted: (flags & 1) !== 0,
            method,
            crc,
            csize,
            size,
            dataStart,
        });
    }
    return entries;
}

/**
 * Inflates one entry, checking its size and CRC.
 * @returns {{content: Buffer, deflated: Buffer}} the file, and the same data as a raw-deflate stream
 */
function extractEntry(buf, entry) {
    if (entry.encrypted) throw new ZipError(`"${entry.name}" is password-protected`);
    const raw = buf.subarray(entry.dataStart, entry.dataStart + entry.csize);
    let content;
    let deflated;
    if (entry.method === 8) {
        try {
            // never produce more than the header promised: a zip bomb can't lie its way past this
            content = entry.size === 0 ? Buffer.alloc(0) : zlib.inflateRawSync(raw, { maxOutputLength: entry.size });
        } catch {
            throw new ZipError(`"${entry.name}" is damaged or does not match its declared size`);
        }
        deflated = raw;
    } else if (entry.method === 0) {
        if (entry.csize !== entry.size) throw new ZipError(`"${entry.name}" is damaged`);
        content = Buffer.from(raw);
        deflated = zlib.deflateRawSync(content);
    } else {
        throw new ZipError(`"${entry.name}" uses an unsupported compression method`);
    }
    if (content.length !== entry.size || crc32(content) !== entry.crc) throw new ZipError(`"${entry.name}" is damaged (checksum mismatch)`);
    return { content, deflated };
}

// --- writing ---------------------------------------------------------------

function dosDateTime(date) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
    return {
        time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
        date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    };
}

/**
 * An entry for the zip writer that comes from memory.
 * @returns {{name, crc, size, csize, mtime, source: Buffer}}
 */
function entryFromBuffer(name, data, mtime) {
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const deflated = zlib.deflateRawSync(content);
    return { name, crc: crc32(content), size: content.length, csize: deflated.length, mtime, source: deflated };
}

/**
 * Works out every header of a zip so we know its exact length before sending a byte.
 * `entries`: [{name, crc, size, csize, mtime, source: Buffer | {path}}], stored data is already raw-deflate.
 */
function planZip(entries) {
    if (entries.length > 0xffff) throw new ZipError("Too many files for one zip");
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        if (e.size > 0xffffffff || e.csize > 0xffffffff) throw new ZipError("File too large for a zip");
        const name = Buffer.from(e.name, "utf8");
        const { time, date } = dosDateTime(e.mtime);

        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(SIG_LOCAL, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // utf-8 names
        local.writeUInt16LE(8, 8); // deflate
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(e.crc >>> 0, 14);
        local.writeUInt32LE(e.csize, 18);
        local.writeUInt32LE(e.size, 22);
        local.writeUInt16LE(name.length, 26);
        name.copy(local, 30);

        const central = Buffer.alloc(46 + name.length);
        central.writeUInt32LE(SIG_CENTRAL, 0);
        central.writeUInt16LE((3 << 8) | 20, 4); // made by: unix, so the permission bits below are honoured
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(e.crc >>> 0, 16);
        central.writeUInt32LE(e.csize, 20);
        central.writeUInt32LE(e.size, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // plain file, rw-r--r--
        central.writeUInt32LE(offset, 42);
        name.copy(central, 46);

        locals.push(local);
        centrals.push(central);
        offset += local.length + e.csize;
    }
    const cdSize = centrals.reduce((n, c) => n + c.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(offset, 16);
    if (offset + cdSize > 0xffffffff) throw new ZipError("Zip too large");
    return { locals, tail: Buffer.concat([...centrals, eocd]), totalLength: offset + cdSize + 22 };
}

async function writeChunk(res, chunk) {
    if (res.destroyed || res.writableEnded) throw new Error("client went away");
    if (!res.write(chunk)) await once(res, "drain");
}

/** Sends the zip to `res` (an http response or any writable), honouring back-pressure. */
async function streamZip(res, entries, plan = planZip(entries)) {
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        await writeChunk(res, plan.locals[i]);
        if (Buffer.isBuffer(e.source)) {
            await writeChunk(res, e.source);
        } else {
            let sent = 0;
            for await (const chunk of fs.createReadStream(e.source.path, { highWaterMark: 64 * 1024 })) {
                sent += chunk.length;
                await writeChunk(res, chunk);
            }
            if (sent !== e.csize) throw new Error(`stored data for ${e.name} is the wrong length`);
        }
    }
    await writeChunk(res, plan.tail);
    res.end();
}

/** Builds a whole zip in memory (used by tests and for small archives). */
function makeZip(files) {
    const entries = files.map((f) => entryFromBuffer(f.name, f.data, f.mtime));
    const plan = planZip(entries);
    const chunks = [];
    entries.forEach((e, i) => chunks.push(plan.locals[i], e.source));
    chunks.push(plan.tail);
    return Buffer.concat(chunks);
}

module.exports = { ZipError, crc32, readZip, extractEntry, entryFromBuffer, planZip, streamZip, makeZip };
