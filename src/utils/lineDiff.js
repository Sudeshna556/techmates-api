"use strict";
// A small line-by-line diff for the review screen. Compares two texts and returns "hunks":
// runs of changed lines with a few unchanged lines around them (like `git diff`).

const CONTEXT = 3;
const MAX_CELLS = 4_000_000; // beyond this the changed middle part is shown as "all removed, all added"

const toLines = (text) => {
    if (text === "") return [];
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines[lines.length - 1] === "") lines.pop(); // a trailing newline is not an extra empty line
    return lines;
};

/** Edit script for two line arrays: [{ t: " " | "-" | "+", text }] */
function edits(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const out = [];
    for (let i = 0; i < start; i++) out.push({ t: " ", text: a[i] });

    const n = endA - start;
    const m = endB - start;
    if (n * m > MAX_CELLS) {
        for (let i = start; i < endA; i++) out.push({ t: "-", text: a[i] });
        for (let j = start; j < endB; j++) out.push({ t: "+", text: b[j] });
    } else if (n === 0 || m === 0) {
        for (let i = start; i < endA; i++) out.push({ t: "-", text: a[i] });
        for (let j = start; j < endB; j++) out.push({ t: "+", text: b[j] });
    } else {
        // longest common subsequence of the differing middle
        const w = m + 1;
        const table = new Uint32Array((n + 1) * w);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                table[i * w + j] = a[start + i] === b[start + j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (a[start + i] === b[start + j]) {
                out.push({ t: " ", text: a[start + i] });
                i++;
                j++;
            } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
                out.push({ t: "-", text: a[start + i++] });
            } else {
                out.push({ t: "+", text: b[start + j++] });
            }
        }
        while (i < n) out.push({ t: "-", text: a[start + i++] });
        while (j < m) out.push({ t: "+", text: b[start + j++] });
    }
    for (let i = endA; i < a.length; i++) out.push({ t: " ", text: a[i] });
    return out;
}

/**
 * @returns {{ added, removed, hunks: [{ oldStart, newStart, lines: [{ t, text }] }] }}
 *   line numbers start at 1; `t` is " " (unchanged), "-" (removed) or "+" (added)
 */
function diffText(before, after) {
    const script = edits(toLines(before), toLines(after));
    let added = 0;
    let removed = 0;
    for (const e of script) {
        if (e.t === "+") added++;
        else if (e.t === "-") removed++;
    }

    // number the lines, then keep only the changed ones plus CONTEXT lines around them
    let oldNo = 1;
    let newNo = 1;
    const numbered = script.map((e) => {
        const row = { ...e, oldNo, newNo };
        if (e.t !== "+") oldNo++;
        if (e.t !== "-") newNo++;
        return row;
    });
    const keep = new Array(numbered.length).fill(false);
    numbered.forEach((row, i) => {
        if (row.t === " ") return;
        for (let k = Math.max(0, i - CONTEXT); k <= Math.min(numbered.length - 1, i + CONTEXT); k++) keep[k] = true;
    });
    const hunks = [];
    let current = null;
    numbered.forEach((row, i) => {
        if (!keep[i]) {
            current = null;
            return;
        }
        if (!current) {
            current = { oldStart: row.oldNo, newStart: row.newNo, lines: [] };
            hunks.push(current);
        }
        current.lines.push({ t: row.t, text: row.text });
    });
    return { added, removed, hunks };
}

module.exports = { diffText };
