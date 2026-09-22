"use strict";
// Can someone's changes be applied on top of the project as it is NOW?
// A change conflicts when the owner (or an earlier merge) touched the same file after the contributor
// started; then the contributor has to update their work instead of us guessing.

/**
 * @param latest   the newest version's files [{path, hash, size, csize, crc}]
 * @param changes  the contribution's changes [{path, kind, hash, size, csize, crc, baseHash}]
 * @returns {{ ok: true, files } | { ok: false, conflicts: string[] }}
 */
function planMerge(latest, changes) {
    const current = new Map(latest.map((f) => [f.path, f]));
    const conflicts = [];
    for (const change of changes) {
        const now = current.get(change.path);
        if (change.kind === "added") {
            if (now && now.hash !== change.hash) conflicts.push(change.path);
        } else if (change.kind === "changed") {
            if (!now || (now.hash !== change.baseHash && now.hash !== change.hash)) conflicts.push(change.path);
        } else if (now && now.hash !== change.baseHash) {
            conflicts.push(change.path); // removed, but the file has changed since
        }
    }
    if (conflicts.length) return { ok: false, conflicts };

    for (const change of changes) {
        if (change.kind === "removed") current.delete(change.path);
        else current.set(change.path, { path: change.path, hash: change.hash, size: change.size, csize: change.csize, crc: change.crc });
    }
    const files = [...current.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { ok: true, files };
}

module.exports = { planMerge };
