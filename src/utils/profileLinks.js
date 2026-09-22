"use strict";
// GitHub and LeetCode profile links. People may paste a full link or just their username; what gets stored is one
// canonical https link. Only those two sites are accepted, because the link is shown as a clickable address on profiles
// (so "javascript:..." or some other site must never get through).

const GITHUB_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const LEETCODE_USER = /^[A-Za-z0-9_.-]{1,40}$/;
// first path pieces on leetcode.com that are pages, not people
const LEETCODE_PAGES = new Set(["problems", "contest", "discuss", "explore", "store", "studyplan", "problemset", "premium", "accounts", "interview", "assessment", "subscribe", "profile"]);

// What follows the site name in a pasted text: { host, segments } for a link on one of the sites, undefined when the text
// is not a link at all (then it is a bare username), or null when it is a link to somewhere else or not usable.
function segmentsOf(text, hosts) {
    const stripped = text.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    const lower = stripped.toLowerCase();
    const host = hosts.find((h) => lower === h || ["/", "?", "#"].some((sep) => lower.startsWith(h + sep)));
    if (!host) return /[/:?#\\\s]/.test(text) ? null : undefined;
    const path = stripped.slice(host.length).split(/[?#]/)[0];
    const decode = (piece) => {
        try {
            return decodeURIComponent(piece);
        } catch {
            return piece;
        }
    };
    return { host, segments: path.split("/").filter(Boolean).map(decode) };
}

function githubUrl(input) {
    if (input === undefined || input === null) return "";
    if (typeof input !== "string") return null;
    const text = input.trim();
    if (!text) return "";
    const found = segmentsOf(text, ["github.com"]);
    if (found === null) return null;
    const name = found === undefined ? text.replace(/^@/, "") : found.segments[0] || "";
    return GITHUB_USER.test(name) ? `https://github.com/${name}` : null;
}

function leetcodeUrl(input) {
    if (input === undefined || input === null) return "";
    if (typeof input !== "string") return null;
    const text = input.trim();
    if (!text) return "";
    const found = segmentsOf(text, ["leetcode.com", "leetcode.cn"]);
    if (found === null) return null;
    let host = "leetcode.com";
    let name;
    if (found === undefined) {
        name = text.replace(/^@/, "");
    } else {
        host = found.host;
        const pieces = found.segments;
        if (pieces[0] === "u") name = pieces.length === 2 ? pieces[1] : undefined;
        else name = pieces.length === 1 && !LEETCODE_PAGES.has(pieces[0].toLowerCase()) ? pieces[0] : undefined;
    }
    return name && LEETCODE_USER.test(name) ? `https://${host}/u/${name}/` : null;
}

// a link that is already in the stored form
const isGithubUrl = (value) => typeof value === "string" && value !== "" && githubUrl(value) === value;
const isLeetcodeUrl = (value) => typeof value === "string" && value !== "" && leetcodeUrl(value) === value;

module.exports = { githubUrl, leetcodeUrl, isGithubUrl, isLeetcodeUrl };
