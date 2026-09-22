"use strict";
// GitHub / LeetCode links: what people type in, what gets stored, and what is refused.
const test = require("node:test");
const assert = require("node:assert/strict");
const { githubUrl, leetcodeUrl, isGithubUrl, isLeetcodeUrl } = require("../src/utils/profileLinks");

test("github: a username or a link becomes one canonical link", () => {
    for (const input of ["octocat", "@octocat", " octocat ", "github.com/octocat", "www.github.com/octocat", "http://github.com/octocat", "https://github.com/octocat",
        "https://GitHub.com/octocat/", "https://github.com/octocat?tab=repositories", "https://github.com/octocat/hello-world", "https://github.com/octocat#top"]) {
        assert.equal(githubUrl(input), "https://github.com/octocat", input);
    }
    assert.equal(githubUrl("Mona-Lisa-99"), "https://github.com/Mona-Lisa-99");
    assert.equal(githubUrl(""), "");
    assert.equal(githubUrl("   "), "");
    assert.equal(githubUrl(null), "");
    assert.equal(githubUrl(undefined), "");
});

test("github: other sites, other schemes and made-up names are refused", () => {
    for (const bad of ["javascript:alert(1)", "https://evil.com/octocat", "https://github.com.evil.com/octocat", "evil.com/github.com/octocat", "https://user:pw@github.com/octocat",
        "https://github.com", "github.com/", "-octocat", "octo cat", "octo_cat", "a".repeat(40), "https://gitlab.com/octocat", "ftp://github.com/octocat", "data:text/html,hi", "//github.com/octocat", 42, {}, ["octocat"]]) {
        assert.equal(githubUrl(bad), null, String(bad));
    }
});

test("leetcode: a username or a link becomes one canonical link", () => {
    for (const input of ["neal_wu", "@neal_wu", "leetcode.com/u/neal_wu", "leetcode.com/u/neal_wu/", "https://leetcode.com/neal_wu/", "https://www.leetcode.com/u/neal_wu",
        "http://leetcode.com/u/neal_wu?envType=daily", "https://LeetCode.com/u/neal_wu/#x"]) {
        assert.equal(leetcodeUrl(input), "https://leetcode.com/u/neal_wu/", input);
    }
    assert.equal(leetcodeUrl("https://leetcode.cn/u/neal_wu/"), "https://leetcode.cn/u/neal_wu/", "the .cn site keeps its own address");
    assert.equal(leetcodeUrl("john.doe-1"), "https://leetcode.com/u/john.doe-1/");
    assert.equal(leetcodeUrl(""), "");
    assert.equal(leetcodeUrl(null), "");
});

test("leetcode: other sites, other schemes, pages that are not people and made-up names are refused", () => {
    for (const bad of ["javascript:alert(1)", "https://evil.com/u/neal_wu", "https://leetcode.com.evil.com/u/neal_wu", "https://leetcode.com/problems/two-sum", "https://leetcode.com/problems/",
        "https://leetcode.com/u/", "https://leetcode.com", "leetcode.com/u/a/b", "https://github.com/neal_wu", "neal wu", "a".repeat(41), "x/y", 7, {}]) {
        assert.equal(leetcodeUrl(bad), null, String(bad));
    }
});

test("the stored form is recognised, and anything else is not", () => {
    assert.ok(isGithubUrl("https://github.com/octocat"));
    assert.ok(!isGithubUrl("octocat"), "a bare username is turned into a link before it is stored");
    assert.ok(!isGithubUrl("https://github.com/octocat/"), "and so is a link with extras");
    assert.ok(!isGithubUrl("http://github.com/octocat"));
    assert.ok(!isGithubUrl(""));
    assert.ok(!isGithubUrl(undefined));
    assert.ok(isLeetcodeUrl("https://leetcode.com/u/neal_wu/"));
    assert.ok(isLeetcodeUrl("https://leetcode.cn/u/neal_wu/"));
    assert.ok(!isLeetcodeUrl("https://leetcode.com/neal_wu"));
    assert.ok(!isLeetcodeUrl("javascript:alert(1)"));
});
