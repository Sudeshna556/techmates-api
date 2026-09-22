// Loads Backend/.env into process.env (no extra npm package needed).
// Real environment variables win over the file, so hosting platforms can set them directly.
const fs = require("fs");
const path = require("path");

const envFile = path.join(__dirname, "..", "..", ".env");

if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
        if (/^\s*(#|$)/.test(line)) continue; // comment or blank line
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match) continue;
        let value = match[2];
        if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
        if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
}

// Stop at startup, with a clear message, if a required setting is missing.
const requireEnv = (...names) => {
    const missing = names.filter((name) => !process.env[name]);
    if (missing.length) {
        throw new Error(`Missing ${missing.join(", ")} - copy Backend/.env.example to Backend/.env and fill it in.`);
    }
    return names.map((name) => process.env[name]);
};

module.exports = { requireEnv };
