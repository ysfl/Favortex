const fs = require("fs");
const { execSync } = require("child_process");

const tag = process.env.RELEASE_TAG || "";
const repo = process.env.GITHUB_REPOSITORY || "";

function run(command) {
  return execSync(command, { encoding: "utf-8" }).trim();
}

function getCommitLog(range) {
  const output = run(
    `git log ${range} --pretty=format:'- %s (%h)' --reverse`
  );
  return output || "- Initial release";
}

const notes = [
  `# Favortex ${tag || ""}`.trim(),
  "",
  "## Highlights",
  "- AI-powered smart bookmarks with rule-first classification.",
  "- Dual summaries (short + long) for quick recall and AI search.",
  "- AI search with embeddings, optional rerank, and follow-up chat.",
  "- Exa /contents integration with fallback parsing.",
  "- Cross-browser packaging for Chrome/Edge and Firefox.",
  "",
  "## Changes",
  getCommitLog(tag || "HEAD"),
  "",
  "## Full Changelog",
  repo && tag ? `https://github.com/${repo}/commits/${tag}` : "",
  ""
]
  .filter((line, index, list) => line !== "" || list[index - 1] !== "")
  .join("\n");

fs.writeFileSync("release-notes.md", notes);
