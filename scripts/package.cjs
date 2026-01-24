const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const yazl = require("yazl");
const writeCrx = require("crx3");

const rootDir = process.cwd();
const artifactsDir = path.join(rootDir, "artifacts");
const distDir = path.join(artifactsDir, "dist");
const distFirefoxDir = path.join(artifactsDir, "dist-firefox");
const keysDir = path.join(rootDir, ".keys");

const packageBase = "favortex";
const zipPath = path.join(artifactsDir, `${packageBase}.zip`);
const xpiPath = path.join(artifactsDir, `${packageBase}.xpi`);
const crxPath = path.join(artifactsDir, `${packageBase}.crx`);
const signedXpiPath = path.join(artifactsDir, `${packageBase}-signed.xpi`);
const keyPath = process.env.CRX_KEY_PATH || path.join(keysDir, `${packageBase}.pem`);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeBackgroundPage(outDir, scriptName) {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Favortex Background</title>
  </head>
  <body>
    <script type="module" src="${scriptName}"></script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(outDir, "background.html"), html);
}

function walk(dirPath, acc = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  entries.forEach((entry) => {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, acc);
    } else if (entry.isFile()) {
      acc.push(fullPath);
    }
  });
  return acc;
}

function toZipPath(baseDir, filePath) {
  const rel = path.relative(baseDir, filePath);
  return rel.split(path.sep).join(path.posix.sep);
}

function zipDir(srcDir, outPath) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.outputStream.once("error", reject);
    const output = fs.createWriteStream(outPath);
    output.once("error", reject);
    output.once("close", resolve);

    walk(srcDir).forEach((filePath) => {
      zip.addFile(filePath, toZipPath(srcDir, filePath));
    });
    zip.end();
    zip.outputStream.pipe(output);
  });
}

function writeKeyFromEnv() {
  const keyBase64 = process.env.CRX_PRIVATE_KEY_B64;
  const keyPlain = process.env.CRX_PRIVATE_KEY;
  if (!keyBase64 && !keyPlain) {
    return false;
  }
  ensureDir(path.dirname(keyPath));
  const content = keyBase64 ? Buffer.from(keyBase64, "base64") : keyPlain;
  fs.writeFileSync(keyPath, content);
  return true;
}

function ensureKeyExists() {
  if (fs.existsSync(keyPath)) {
    return;
  }
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 4096 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  fs.writeFileSync(keyPath, pem);
}

function prepareFirefoxDist() {
  if (fs.existsSync(distFirefoxDir)) {
    fs.rmSync(distFirefoxDir, { recursive: true, force: true });
  }
  fs.cpSync(distDir, distFirefoxDir, { recursive: true });
  const manifestPath = path.join(distFirefoxDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const mv3Action = manifest.action;
  if (mv3Action) {
    manifest.browser_action = mv3Action;
    delete manifest.action;
  }
  if (manifest.background && typeof manifest.background === "object") {
    const serviceWorker = manifest.background.service_worker;
    delete manifest.background.type;
    if (serviceWorker) {
      writeBackgroundPage(distFirefoxDir, serviceWorker);
      manifest.background = {
        page: "background.html",
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

function signFirefoxXpi() {
  const issuer = process.env.AMO_JWT_ISSUER;
  const secret = process.env.AMO_JWT_SECRET;
  if (!issuer || !secret) {
    console.log("Skipping Firefox signing: AMO credentials not set.");
    return;
  }
  const webExtBin = path.join(
    rootDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "web-ext.cmd" : "web-ext"
  );
  if (!fs.existsSync(webExtBin)) {
    throw new Error("web-ext binary not found. Install it to enable signing.");
  }
  const signedDir = path.join(artifactsDir, "firefox-signed");
  ensureDir(signedDir);
  const result = spawnSync(
    webExtBin,
    [
      "sign",
      "--source-dir",
      distFirefoxDir,
      "--artifacts-dir",
      signedDir,
      "--channel",
      "unlisted",
      "--api-key",
      issuer,
      "--api-secret",
      secret
    ],
    { stdio: "inherit" }
  );
  if (result.status !== 0) {
    throw new Error("web-ext sign failed");
  }
  const signed = fs.readdirSync(signedDir).find((file) => file.endsWith(".xpi"));
  if (signed) {
    fs.copyFileSync(path.join(signedDir, signed), signedXpiPath);
    console.log(`Signed XPI: ${signedXpiPath}`);
  }
}

async function main() {
  if (!fs.existsSync(distDir)) {
    throw new Error(`Missing dist directory at ${distDir}. Run build first.`);
  }
  ensureDir(artifactsDir);
  ensureDir(path.dirname(keyPath));

  const wroteKey = writeKeyFromEnv();
  if (!wroteKey) {
    ensureKeyExists();
  }

  prepareFirefoxDist();
  await zipDir(distFirefoxDir, xpiPath);
  await writeCrx([distDir], {
    crxPath,
    zipPath,
    keyPath
  });
  signFirefoxXpi();

  console.log(`CRX: ${crxPath}`);
  console.log(`XPI: ${xpiPath}`);
  console.log(`ZIP: ${zipPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
