// Packs the Claude Desktop extension out/mcpb/sevdesk-mcp.mcpb from dist/.
//
//   npm run build:mcpb        builds dist/ first, then runs this script
//   node scripts/build-mcpb.mjs
//
// The bundle is a server of type "node": dist/, package.json and the production
// dependencies installed from package-lock.json, plus mcpb/manifest.json and the
// icon. Claude Desktop runs it with its built-in Node.js. The manifest takes its
// version from package.json, which the release job stamps with the tag version;
// mcpb/manifest.json itself keeps the placeholder 0.0.0.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const path = (relative) => fileURLToPath(new URL(relative, root));
const STAGE = path("out/mcpb/stage/");
const OUTPUT = path("out/mcpb/sevdesk-mcp.mcpb");
const MCPB_CLI = path("node_modules/@anthropic-ai/mcpb/dist/cli/cli.js");

function fail(message) {
  console.error(`build-mcpb: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) fail(`cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with ${result.status}`);
}

const { version } = JSON.parse(readFileSync(path("package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json version ${version} is not X.Y.Z`);
for (const required of ["dist/bin/stdio.js", "mcpb/manifest.json", "mcpb/icon.png"]) {
  if (!existsSync(path(required))) {
    fail(`${required} is missing${required.startsWith("dist/") ? '; run "npm run build"' : ""}`);
  }
}
if (!existsSync(MCPB_CLI)) fail(`${MCPB_CLI} is missing; run "npm ci"`);

rmSync(STAGE, { recursive: true, force: true });
rmSync(OUTPUT, { force: true });
mkdirSync(STAGE, { recursive: true });

// version.js reads ../package.json at runtime, so the bundle needs it beside dist/.
// The lockfile installs exactly the released dependency tree; mcpb leaves it out of the archive.
cpSync(path("dist/"), `${STAGE}dist/`, { recursive: true });
for (const file of ["package.json", "package-lock.json", "LICENSE"]) {
  cpSync(path(file), `${STAGE}${file}`);
}
cpSync(path("mcpb/icon.png"), `${STAGE}icon.png`);

const manifest = JSON.parse(readFileSync(path("mcpb/manifest.json"), "utf8"));
manifest.version = version;
writeFileSync(`${STAGE}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

// Production dependencies only; no install scripts run.
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: STAGE,
  // Not the caller's npm_config_* (e.g. from "npm run"), which could re-add dev dependencies.
  env: Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith("npm_config_")),
  ),
});

run(process.execPath, [MCPB_CLI, "validate", `${STAGE}manifest.json`]);
run(process.execPath, [MCPB_CLI, "pack", STAGE, OUTPUT]);
if (!existsSync(OUTPUT)) fail(`mcpb pack reported success but wrote no ${OUTPUT}`);
writeFileSync(OUTPUT, fixZipTimestamps(readFileSync(OUTPUT)));
console.error(`build-mcpb: ${OUTPUT} (${version})`);

/**
 * mcpb pack stamps every entry with the time of the build. Sets all of them to
 * 1980-01-01 00:00, the earliest DOS date, so the same inputs give the same file.
 * Only the time and date fields change; sizes, offsets and CRCs stay valid.
 */
function fixZipTimestamps(zip) {
  const DOS_TIME = 0;
  const DOS_DATE = (1 << 5) | 1;
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) fail("no end of central directory in the archive");
  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) fail(`bad central directory entry ${i}`);
    zip.writeUInt16LE(DOS_TIME, offset + 12);
    zip.writeUInt16LE(DOS_DATE, offset + 14);
    const local = zip.readUInt32LE(offset + 42);
    if (zip.readUInt32LE(local) !== 0x04034b50) fail(`bad local header for entry ${i}`);
    zip.writeUInt16LE(DOS_TIME, local + 10);
    zip.writeUInt16LE(DOS_DATE, local + 12);
    // Fixed part, then file name, extra field and comment.
    offset +=
      46 +
      zip.readUInt16LE(offset + 28) +
      zip.readUInt16LE(offset + 30) +
      zip.readUInt16LE(offset + 32);
  }
  return zip;
}
