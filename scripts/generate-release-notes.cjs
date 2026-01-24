const fs = require("fs");
const https = require("https");
const { execSync } = require("child_process");

const tag = process.env.RELEASE_TAG || "";
const repo = process.env.GITHUB_REPOSITORY || "";
const token = process.env.GITHUB_TOKEN || "";

function run(command) {
  return execSync(command, { encoding: "utf-8" }).trim();
}

function getTags() {
  const output = run("git tag --sort=-v:refname");
  if (!output) {
    return [];
  }
  return output.split("\n").map((value) => value.trim()).filter(Boolean);
}

function getPreviousTag(tags, currentTag) {
  if (!currentTag) {
    return "";
  }
  const index = tags.indexOf(currentTag);
  if (index === -1) {
    return "";
  }
  return tags[index + 1] || "";
}

function requestNotes(payload) {
  return new Promise((resolve, reject) => {
    const [owner, name] = repo.split("/");
    if (!owner || !name) {
      reject(new Error("Invalid repository name."));
      return;
    }
    const body = JSON.stringify(payload);
    const request = https.request(
      {
        method: "POST",
        hostname: "api.github.com",
        path: `/repos/${owner}/${name}/releases/generate-notes`,
        headers: {
          "User-Agent": "favortex-release-notes",
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          if (response.statusCode && response.statusCode >= 400) {
            reject(new Error(`GitHub API error: ${response.statusCode} ${data}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.body || "");
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

async function main() {
  if (!tag) {
    throw new Error("Missing RELEASE_TAG.");
  }
  if (!repo) {
    throw new Error("Missing GITHUB_REPOSITORY.");
  }
  if (!token) {
    throw new Error("Missing GITHUB_TOKEN.");
  }

  const tags = getTags();
  const previousTag = getPreviousTag(tags, tag);
  const payload = {
    tag_name: tag
  };
  if (previousTag) {
    payload.previous_tag_name = previousTag;
  }
  const notes = await requestNotes(payload);
  fs.writeFileSync("release-notes.md", notes);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
