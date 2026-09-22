"use strict";
// Rules for what may go into a shared project: safe paths, what is left out automatically,
// and how a folder "scope" limits what a member can see.

const LIMITS = {
    MAX_ZIP_BYTES: 25 * 1024 * 1024, // the uploaded archive
    MAX_PROJECT_BYTES: 25 * 1024 * 1024, // all included files, uncompressed
    MAX_FILE_BYTES: 5 * 1024 * 1024, // one file
    MAX_FILES: 2000,
    MAX_PREVIEW_BYTES: 256 * 1024, // largest file the browser viewer will show
    MAX_PROJECTS_PER_USER: 10,
    MAX_VERSIONS: 30, // older versions are dropped beyond this
    MAX_PATH_LENGTH: 300,
    MAX_PATH_DEPTH: 30,
};

// reserved: the client puts its file list here when it uploads only what changed
const MANIFEST_PATH = ".techmates/manifest.json";

// folders that are never worth sharing (dependencies, build output, editor/OS clutter)
const IGNORED_DIRS = new Set([
    "node_modules", "bower_components", "jspm_packages",
    ".git", ".svn", ".hg",
    "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".output", ".turbo", ".parcel-cache", ".cache",
    "coverage", ".nyc_output",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".tox", "venv", ".venv", "env",
    ".gradle", ".idea", ".vs", ".terraform", ".expo",
    "__MACOSX",
    ".techmates",
]);
const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const IGNORED_EXTENSIONS = [".log", ".pyc", ".pyo", ".class", ".swp", ".swo", ".tmp"];

const KEY_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".ppk", ".kdbx"];
const ENV_TEMPLATE_SUFFIXES = new Set(["example", "sample", "template", "dist", "defaults", "default", "schema"]);
const SECRET_FILE_NAMES = new Set([
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
    ".htpasswd", ".netrc", ".pgpass", ".git-credentials",
    "serviceaccountkey.json", "secrets.json", "secrets.yml", "secrets.yaml",
]);

/**
 * Turns a path from a zip / request into a clean relative path, or returns null when it
 * is unsafe (absolute, "..", drive letters, control characters, too long / deep).
 */
function normalizePath(input) {
    if (typeof input !== "string" || input.length === 0) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(input)) return null;
    const p = input.replace(/\\/g, "/");
    if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
    const parts = p.split("/").filter((part) => part !== "" && part !== ".");
    if (parts.length === 0 || parts.length > LIMITS.MAX_PATH_DEPTH) return null;
    if (parts.some((part) => part === "..")) return null;
    const clean = parts.join("/");
    if (clean.length > LIMITS.MAX_PATH_LENGTH) return null;
    return clean;
}

/** Why a file is left out automatically ("node_modules/", ".DS_Store", "*.log"), or null when it is kept. */
function ignoredBy(path) {
    const parts = path.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
        if (IGNORED_DIRS.has(parts[i])) return `${parts[i]}/`;
    }
    const name = parts[parts.length - 1];
    if (IGNORED_FILES.has(name)) return name;
    const lower = name.toLowerCase();
    const ext = IGNORED_EXTENSIONS.find((e) => lower.endsWith(e));
    return ext ? `*${ext}` : null;
}

/** Files that are secrets by their very name (.env, private keys, ...). Returns a reason or null. */
function secretFileReason(path) {
    const name = path.split("/").pop();
    const lower = name.toLowerCase();
    if (lower === ".env") return "environment file";
    if (lower.startsWith(".env.")) {
        return ENV_TEMPLATE_SUFFIXES.has(lower.slice(5)) ? null : "environment file";
    }
    if (KEY_EXTENSIONS.some((e) => lower.endsWith(e))) return "private key / certificate store";
    if (SECRET_FILE_NAMES.has(lower)) return "credentials file";
    return null;
}

/** A folder limit such as "src/components/" -> "src/components", or null if invalid. */
function normalizePrefix(input) {
    if (typeof input !== "string") return null;
    return normalizePath(input.trim());
}

/** Is `path` inside one of the folder prefixes? An empty scope means the whole project. */
function inScope(path, scope) {
    if (!scope || scope.length === 0) return true;
    return scope.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Compares two file lists ({path, hash}) and says what was added, changed and removed. */
function diffManifests(previous, next) {
    const before = new Map((previous || []).map((f) => [f.path, f.hash]));
    const after = new Map(next.map((f) => [f.path, f.hash]));
    const added = [];
    const changed = [];
    const removed = [];
    for (const [path, hash] of after) {
        if (!before.has(path)) added.push(path);
        else if (before.get(path) !== hash) changed.push(path);
    }
    for (const path of before.keys()) if (!after.has(path)) removed.push(path);
    return { added, changed, removed };
}

const isSha256 = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

module.exports = {
    LIMITS,
    MANIFEST_PATH,
    IGNORED_DIRS,
    normalizePath,
    normalizePrefix,
    ignoredBy,
    secretFileReason,
    inScope,
    diffManifests,
    isSha256,
};
