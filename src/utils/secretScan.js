"use strict";
// Looks through text files for things that must not be shared: API keys, tokens, private keys,
// passwords in connection strings and hard-coded secrets. Findings only ever carry a MASKED
// preview - the secret itself is never sent back or stored.

const MAX_SCAN_BYTES = 1024 * 1024; // bigger files are not scanned (they are almost always data / bundles)
const MAX_LINE = 3000; // very long lines are minified bundles
const SKIP_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock", "cargo.lock", "poetry.lock", "gemfile.lock"]);
const SKIP_SUFFIXES = [".min.js", ".min.css", ".map"];

// values that are obviously placeholders, not real secrets
const PLACEHOLDER =
    /^(?:<[^>]*>|\$\{?[A-Za-z_][^}]*\}?|%[sd]|\{\{.*\}\}|x{3,}|\*{3,}|\.{3,}|your[-_ ]?.*|change[-_ ]?me|example.*|dummy.*|placeholder.*|redacted.*|password\d*|passw0rd|pass|secret|test(?:ing)?|process\.env.*|env:.*|os\.environ.*)$/i;

const isPlaceholder = (value) => PLACEHOLDER.test(value) || /^(.)\1+$/.test(value);

// a value that looks generated: mixes character types and contains a digit or symbol (or is long)
function looksRandom(value) {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
    if (classes < 2) return false;
    return /[0-9]/.test(value) || /[^A-Za-z0-9]/.test(value) || value.length >= 20;
}

// group = which capture group holds the secret (0 = whole match); ok(value) can veto a match
const RULES = [
    { id: "private-key", label: "Private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g, group: 0, showAll: true },
    { id: "aws-key", prefix: true, label: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, group: 0 },
    { id: "github-token", prefix: true, label: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,})\b/g, group: 0 },
    { id: "slack-token", prefix: true, label: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, group: 0 },
    { id: "google-key", prefix: true, label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, group: 0 },
    { id: "stripe-key", prefix: true, label: "Stripe live key", re: /\b[sr]k_live_[0-9a-zA-Z]{16,}\b/g, group: 0 },
    { id: "ai-key", prefix: true, label: "API key (sk-...)", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/g, group: 0 },
    { id: "jwt", prefix: true, label: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, group: 0 },
    {
        id: "connection-string",
        label: "Password in a database connection string",
        re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|rediss?|amqps?):\/\/[^\s:/@'"`<>]+:([^\s@'"`<>/]{3,})@[^\s'"`]+/g,
        group: 1,
        ok: (v) => !isPlaceholder(v),
    },
    {
        id: "jwt-secret",
        label: "Hard-coded JWT secret",
        re: /\bjwt\.(?:sign|verify)\s*\([^()]*?,\s*(["'`])([^"'`\n]{4,})\1/g,
        group: 2,
        ok: (v) => !isPlaceholder(v),
    },
    { id: "npm-token", label: "npm auth token", re: /_authToken\s*=\s*([^\s"']{8,})/g, group: 1, ok: (v) => !isPlaceholder(v) },
    {
        id: "hardcoded-secret",
        label: "Hard-coded password / secret / key",
        re: /\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*["']?\s*[:=]\s*(["'`])([^"'`\s]{8,})\1/gi,
        group: 2,
        ok: (v) => !isPlaceholder(v) && looksRandom(v),
    },
];

// Tokens keep their well-known prefix (ghp_, AKIA, ...) so people can recognise them;
// passwords and secrets are masked completely.
function maskValue(value, rule) {
    if (rule.showAll) return value;
    return `${rule.prefix ? value.slice(0, 4) : ""}${"•".repeat(6)}`;
}

function isBinary(buf) {
    const n = Math.min(buf.length, 8000);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
}

/** Scans one file's text. Returns [{path, line, kind, id, preview}]. */
function scanText(path, text) {
    const findings = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > MAX_LINE || line.length < 8) continue;
        for (const rule of RULES) {
            rule.re.lastIndex = 0;
            let m;
            while ((m = rule.re.exec(line)) !== null) {
                const secret = m[rule.group];
                if (!secret) continue;
                if (rule.ok && !rule.ok(secret)) continue;
                // preview = the matched text with only the secret part masked
                const masked = maskValue(secret, rule);
                let preview = m[0].replace(secret, masked);
                if (preview.length > 70) preview = `${preview.slice(0, 67)}...`;
                findings.push({ path, line: i + 1, kind: rule.label, id: rule.id, preview });
                break; // one finding per rule per line is plenty
            }
        }
    }
    return findings;
}

/** Scans a file's bytes (skips binaries, lock files and very large files). */
function scanFile(path, buf) {
    const name = path.split("/").pop().toLowerCase();
    if (SKIP_FILES.has(name) || SKIP_SUFFIXES.some((s) => name.endsWith(s))) return [];
    if (buf.length > MAX_SCAN_BYTES || buf.length < 8 || isBinary(buf)) return [];
    return scanText(path, buf.toString("utf8"));
}

module.exports = { scanFile, scanText, isBinary, RULES };
