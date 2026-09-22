"use strict";
// A tiny in-memory stand-in for the Mongoose models, just rich enough to run the real routes
// over real HTTP without a database. (It cannot prove that Mongo itself answers the same way.)

let counter = 0;
const newId = () => (++counter).toString(16).padStart(24, "0");

const norm = (v) => (v instanceof Date ? v.getTime() : v && typeof v === "object" && v._id !== undefined && !Array.isArray(v) ? String(v._id) : v == null ? v : typeof v === "object" ? v.toString() : v);

// all values found at a dotted path, walking through arrays
function valuesAt(obj, pathStr) {
    let cur = [obj];
    for (const key of pathStr.split(".")) {
        cur = cur.flatMap((c) => (c == null ? [] : Array.isArray(c) ? c.map((x) => (x == null ? undefined : x[key])) : [c[key]])).flatMap((x) => (Array.isArray(x) ? x : [x]));
    }
    return cur;
}

function opMatch(candidates, cond) {
    if (cond instanceof Date || cond === null || typeof cond !== "object") {
        if (cond === null) return candidates.every((c) => c === undefined || c === null);
        return candidates.some((c) => norm(c) === norm(cond));
    }
    return Object.entries(cond).every(([op, arg]) => {
        const a = norm(arg);
        switch (op) {
            case "$gt": return candidates.some((c) => c != null && norm(c) > a);
            case "$gte": return candidates.some((c) => c != null && norm(c) >= a);
            case "$lt": return candidates.some((c) => c != null && norm(c) < a);
            case "$lte": return candidates.some((c) => c != null && norm(c) <= a);
            case "$ne": return !candidates.some((c) => norm(c) === a);
            case "$in": return candidates.some((c) => arg.map(norm).includes(norm(c)));
            case "$nin": return !candidates.some((c) => arg.map(norm).includes(norm(c)));
            default: throw new Error(`fake db: unsupported operator ${op}`);
        }
    });
}

function matches(row, filter) {
    return Object.entries(filter).every(([key, cond]) => {
        if (key === "$or") return cond.some((sub) => matches(row, sub));
        if (key === "$and") return cond.every((sub) => matches(row, sub));
        return opMatch(valuesAt(row, key), cond);
    });
}

const clone = (v) => (v instanceof Date ? new Date(v) : Array.isArray(v) ? v.map(clone) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v);

function project(row, spec) {
    if (!spec) return row;
    if (Array.isArray(spec)) spec = spec.join(" "); // Mongoose accepts both "a b" and ["a", "b"]
    const fields = spec.split(/\s+/).filter(Boolean);
    if (fields[0].startsWith("-")) {
        const drop = new Set(fields.map((f) => f.slice(1)));
        return Object.fromEntries(Object.entries(row).filter(([k]) => !drop.has(k)));
    }
    const out = { _id: row._id };
    for (const f of fields) {
        const [head, sub] = f.split(".");
        if (sub) out[head] = (row[head] || []).map((x) => ({ [sub]: x[sub] }));
        else out[head] = row[f];
    }
    return out;
}

function makeModel(name, { defaults = () => ({}), refs = {}, timestamps = true } = {}) {
    const rows = [];
    const registry = makeModel.registry;
    const Model = {
        name,
        _rows: rows,
        _reset() { rows.length = 0; },
        _wrap(row) {
            const doc = Object.assign(Object.create({
                async save() { const i = rows.findIndex((r) => r._id === this._id); rows[i] = clone(this); if (timestamps) rows[i].updatedAt = new Date(); return this; },
                toObject() { return clone(this); },
            }), clone(row));
            return doc;
        },
        async create(data) {
            const row = { _id: newId(), ...defaults(), ...clone(data) };
            for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
            if (timestamps) { row.createdAt = new Date(); row.updatedAt = row.createdAt; }
            // unique indexes we rely on
            if (name === "ProjectVersion" && rows.some((r) => String(r.project) === String(row.project) && r.number === row.number)) { const e = new Error("E11000 duplicate key"); e.code = 11000; throw e; }
            if (name === "ProjectAccess" && rows.some((r) => String(r.project) === String(row.project) && String(r.user) === String(row.user))) { const e = new Error("E11000 duplicate key"); e.code = 11000; throw e; }
            rows.push(row);
            return Model._wrap(row);
        },
        find(filter = {}) { return query(rows.filter((r) => matches(r, filter)).map(clone), false); },
        findOne(filter = {}) { return query(rows.filter((x) => matches(x, filter)).map(clone), true); }, // like Mongo: sort/select apply before the first match is taken
        findById(id) { return Model.findOne({ _id: id }); },
        async countDocuments(filter = {}) { return rows.filter((r) => matches(r, filter)).length; },
        async exists(filter = {}) { const r = rows.find((x) => matches(x, filter)); return r ? { _id: r._id } : null; },
        async updateOne(filter, update) {
            const r = rows.find((x) => matches(x, filter));
            if (!r) return { matchedCount: 0, modifiedCount: 0 };
            Object.assign(r, clone(update.$set || {}));
            for (const [k, v] of Object.entries(update.$inc || {})) r[k] = (r[k] || 0) + v;
            return { matchedCount: 1, modifiedCount: 1 };
        },
        async updateMany(filter, update) {
            const hit = rows.filter((x) => matches(x, filter));
            for (const r of hit) Object.assign(r, clone(update.$set || {}));
            return { matchedCount: hit.length, modifiedCount: hit.length };
        },
        async findByIdAndUpdate(id, update, opts = {}) {
            const before = rows.find((x) => x._id === id);
            if (!before) return null;
            const snapshot = clone(before);
            await Model.updateOne({ _id: id }, update);
            return Model._wrap(opts.new ? rows.find((x) => x._id === id) : snapshot);
        },
        async deleteMany(filter = {}) { for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], filter)) rows.splice(i, 1); },
        async deleteOne(filter = {}) { const i = rows.findIndex((x) => matches(x, filter)); if (i >= 0) rows.splice(i, 1); },
        async findOneAndDelete(filter = {}) {
            const i = rows.findIndex((x) => matches(x, filter));
            if (i < 0) return null;
            const [removed] = rows.splice(i, 1);
            return Model._wrap(removed);
        },
    };

    function query(list, single) {
        const q = {
            _sort: null, _limit: null, _skip: 0, _select: null, _pops: [], _lean: false,
            sort(s) { q._sort = s; return q; },
            limit(n) { q._limit = Number(n); return q; },
            skip(n) { q._skip = Number(n) || 0; return q; },
            select(s) { q._select = s; return q; },
            lean() { q._lean = true; return q; },
            populate(field, sel) { q._pops.push([field, sel]); return q; },
            then(resolve, reject) {
                let out = list;
                if (q._sort) { const [[k, dir]] = Object.entries(q._sort); out = [...out].sort((a, b) => (norm(a[k]) < norm(b[k]) ? -1 : norm(a[k]) > norm(b[k]) ? 1 : 0) * dir); }
                if (q._skip) out = out.slice(q._skip);
                if (q._limit) out = out.slice(0, q._limit);
                out = out.map((r) => project(r, q._select));
                for (const [field, sel] of q._pops) {
                    const target = registry[refs[field]];
                    out = out.map((r) => { const found = target && target._rows.find((x) => x._id === String(r[field])); return { ...r, [field]: found ? project(clone(found), sel) : null }; });
                }
                const finish = q._lean ? out : out.map((r) => Model._wrap(r));
                return Promise.resolve(single ? finish[0] || null : finish).then(resolve, reject);
            },
        };
        return q;
    }
    registry[name] = Model;
    return Model;
}
makeModel.registry = {};

function build() {
    makeModel.registry = {};
    const User = makeModel("User", { timestamps: false });
    const Project = makeModel("Project", { defaults: () => ({ description: "", versionSeq: 0, latestVersion: 0, fileCount: 0, bytes: 0, visibility: "friends", openDownloads: false }), refs: { owner: "User" } });
    const ProjectVersion = makeModel("ProjectVersion", { defaults: () => ({ message: "", files: [], fileCount: 0, bytes: 0, summary: { added: 0, changed: 0, removed: 0 }, overrides: 0 }), refs: { contributedBy: "User" }, timestamps: false });
    ProjectVersion._create = ProjectVersion.create;
    ProjectVersion.create = async (d) => { const doc = await ProjectVersion._create({ createdAt: new Date(), ...d }); return doc; };
    const ProjectAccess = makeModel("ProjectAccess", { defaults: () => ({ status: "active", lastFetchedVersion: null }), refs: { user: "User" } });
    const ProjectContribution = makeModel("ProjectContribution", { defaults: () => ({ status: "asking", explanation: "", decisionNote: "", changes: [], summary: { added: 0, changed: 0, removed: 0 } }), refs: { author: "User", project: "Project" } });
    const ProjectActivity = makeModel("ProjectActivity", { defaults: () => ({ at: new Date(), detail: {} }), refs: { actor: "User", target: "User" }, timestamps: false });
    const Message = makeModel("message", { defaults: () => ({ text: "", projectName: "", readAt: null }), refs: { from: "User", to: "User" } });
    const ConnectionRequest = makeModel("connectionRequest", { refs: { fromUserId: "User", toUserId: "User" } });
    return { User, Project, ProjectVersion, ProjectAccess, ProjectActivity, ProjectContribution, ConnectionRequest, Message };
}

module.exports = { build, newId };
