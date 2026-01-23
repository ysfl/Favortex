const fs = require("fs");
const path = require("path");

const rootDir = process.cwd();
const defaultArtifactsDir = path.resolve(rootDir, "artifacts");
const srcDir = path.resolve(
  rootDir,
  process.argv[2] || path.join(defaultArtifactsDir, "dist")
);
const outDir = path.resolve(
  rootDir,
  process.argv[3] || path.join(defaultArtifactsDir, "dist-firefox")
);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function convertManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const mv3Action = manifest.action;
  if (mv3Action) {
    manifest.browser_action = mv3Action;
    delete manifest.action;
  }
  if (manifest.background && typeof manifest.background === "object") {
    delete manifest.background.type;
    if (manifest.background.service_worker) {
      manifest.background = {
        scripts: [manifest.background.service_worker],
        persistent: false
      };
    }
  }
  if (manifest.host_permissions) {
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    const hostPermissions = Array.isArray(manifest.host_permissions)
      ? manifest.host_permissions
      : [];
    manifest.permissions = Array.from(new Set([...permissions, ...hostPermissions]))
      .filter((perm) => perm !== "scripting");
    delete manifest.host_permissions;
  } else if (Array.isArray(manifest.permissions)) {
    manifest.permissions = manifest.permissions.filter((perm) => perm !== "scripting");
  }
  if (manifest.content_security_policy && typeof manifest.content_security_policy === "object") {
    manifest.content_security_policy =
      manifest.content_security_policy.extension_pages ||
      "script-src 'self'; object-src 'self'";
  }
  manifest.manifest_version = 2;
  writeJson(manifestPath, manifest);
}

function main() {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Missing source directory: ${srcDir}`);
  }
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  ensureDir(outDir);
  fs.cpSync(srcDir, outDir, { recursive: true });
  convertManifest(path.join(outDir, "manifest.json"));
  console.log(`Firefox-ready build: ${outDir}`);
}

main();
