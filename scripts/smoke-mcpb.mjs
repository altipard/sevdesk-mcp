// Unpacks the Claude Desktop extension and starts its server the way the
// client would: command, arguments and environment resolved from manifest.json
// by getMcpConfigForManifest, the function of the mcpb package that clients use
// (user_config defaults included). Checks initialize and tools/list for the
// default and a cleared mode (read-only), for mode "full" (write tools, no
// irreversible ones) and once with the irreversible tools enabled on top.
// No network: the token is a dummy and the base URL points at a closed local
// port.
//
//   node scripts/smoke-mcpb.mjs [path]   default: out/mcpb/sevdesk-mcp.mcpb
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getMcpConfigForManifest } from "@anthropic-ai/mcpb";
import {
  DUMMY_TOKEN,
  EXPECTED_TOOLS,
  fail,
  OFFLINE_BASE_URL,
  smokeServer,
  WRITE_TOOLS,
  X_TOOLS,
} from "./smoke-bin.mjs";

const root = new URL("../", import.meta.url);
const bundle = process.argv[2] ?? fileURLToPath(new URL("out/mcpb/sevdesk-mcp.mcpb", root));
const MCPB_CLI = fileURLToPath(new URL("node_modules/@anthropic-ai/mcpb/dist/cli/cli.js", root));
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

if (!existsSync(bundle)) fail(`${bundle} is missing; run "npm run build:mcpb" first`);

function mcpb(...args) {
  const result = spawnSync(process.execPath, [MCPB_CLI, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`mcpb ${args[0]} exited with ${result.status}`, `${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

const dir = mkdtempSync(join(tmpdir(), "sevdesk-mcpb-"));
// On "exit": fail() ends the process directly, past any finally block.
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
mcpb("info", bundle);
mcpb("unpack", bundle, dir);
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
if (manifest.version !== version) {
  fail(`manifest version ${manifest.version}, package.json has ${version}`);
}
const { api_token: token, mode } = manifest.user_config ?? {};
if (!token?.sensitive || !token.required)
  fail("user_config.api_token must be sensitive and required");
if (mode?.default !== "read") fail(`user_config.mode defaults to ${mode?.default}, expected read`);
if (manifest.server?.type !== "node") fail(`server.type is ${manifest.server?.type}`);
if (!existsSync(join(dir, manifest.server.entry_point))) {
  fail(`entry point ${manifest.server.entry_point} is not in the bundle`);
}

async function run(label, userConfig, extraEnv, expectedTools, { forbidden = [] } = {}) {
  const config = await getMcpConfigForManifest({
    manifest,
    extensionPath: dir,
    systemDirs: {},
    userConfig,
    pathSeparator: sep,
  });
  if (!config) fail(`${label}: no MCP config for user_config ${Object.keys(userConfig)}`);
  const unresolved = JSON.stringify(config).match(/\$\{[^}]*\}/);
  if (unresolved) fail(`${label}: ${unresolved[0]} left unresolved in ${JSON.stringify(config)}`);
  const env = config.env ?? {};
  if (env.SEVDESK_API_TOKEN !== DUMMY_TOKEN) fail("api_token does not reach SEVDESK_API_TOKEN");
  if (env.SEVDESK_MODE !== (userConfig.mode ?? mode.default)) {
    fail(`mode does not reach SEVDESK_MODE (${env.SEVDESK_MODE})`);
  }
  const names = await smokeServer({
    label,
    // Claude Desktop runs "node" with its built-in runtime; here the one running this script.
    command: config.command === "node" ? process.execPath : config.command,
    args: config.args ?? [],
    env: {
      PATH: process.env.PATH ?? "",
      ...env,
      SEVDESK_BASE_URL: OFFLINE_BASE_URL,
      LOG_LEVEL: "warn",
      ...extraEnv,
    },
    expectedTools,
    version,
  });
  const unexpected = names.filter((name) => forbidden.includes(name));
  if (unexpected.length > 0) fail(`${label}: lists ${unexpected.join(", ")}`);
  return names;
}

const READ_ONLY = { forbidden: WRITE_TOOLS };
const defaults = await run(
  "mcpb default",
  // Only the token, as after a fresh install: the mode comes from the manifest default.
  { api_token: DUMMY_TOKEN },
  {},
  EXPECTED_TOOLS,
  READ_ONLY,
);
// A mode field the user cleared reaches the server as "", which means read.
await run("mcpb cleared mode", { api_token: DUMMY_TOKEN, mode: "" }, {}, EXPECTED_TOOLS, READ_ONLY);
// What the client starts in full mode: the irreversible tools stay off without
// SEVDESK_ENABLE_TOOLS, which the manifest does not pass.
const reversible = WRITE_TOOLS.filter((name) => !X_TOOLS.includes(name));
const full = await run(
  "mcpb full",
  { api_token: DUMMY_TOKEN, mode: "full" },
  {},
  [...EXPECTED_TOOLS, ...reversible],
  { forbidden: X_TOOLS },
);
// Not a client setup: checks that the irreversible tools are in the bundle at all.
const all = await run(
  "mcpb full with SEVDESK_ENABLE_TOOLS (not set by the client)",
  { api_token: DUMMY_TOKEN, mode: "full" },
  { SEVDESK_ENABLE_TOOLS: X_TOOLS.join(",") },
  [...EXPECTED_TOOLS, ...WRITE_TOOLS],
);

console.error(
  `smoke-mcpb: ${bundle} ${version} ok, ${defaults.length} tools by default, ` +
    `${full.length} in full mode, ${all.length} with the irreversible tools enabled`,
);
