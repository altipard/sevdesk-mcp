// Starts a compiled binary as an MCP client would, sends initialize and
// tools/list over stdin and checks the answers. No network: the token is a
// dummy and the base URL points at a closed local port, and neither request
// reaches sevdesk.
//
//   node scripts/smoke-bin.mjs [path]   default: out/bin/sevdesk-mcp-<host>
//   SMOKE_ARCH=x86_64 node scripts/smoke-bin.mjs out/bin/sevdesk-mcp-darwin-x64
//                                       macOS only: runs the binary under Rosetta
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const host = `${process.platform}-${process.arch}`;
const bin = process.argv[2] ?? fileURLToPath(new URL(`out/bin/sevdesk-mcp-${host}`, root));
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const DUMMY_TOKEN = "0123456789abcdef0123456789abcdef";
const EXPECTED_TOOLS = ["get_account_info", "search_invoices", "sevdesk_api_request"];

function fail(message, stderr = "") {
  console.error(`smoke-bin: ${message}`);
  if (stderr) console.error(stderr.trimEnd());
  process.exit(1);
}

if (!existsSync(bin)) fail(`${bin} is missing; run "npm run build:bin" first`);

// Only what the binary needs: a real token in the caller's environment must
// not reach it, and the keychain is never asked because the variable is set.
const arch = process.env.SMOKE_ARCH;
if (arch !== undefined && !/^[a-z0-9_]+$/.test(arch)) fail(`invalid SMOKE_ARCH ${arch}`);
const [command, args] = arch ? ["/usr/bin/arch", [`-${arch}`, bin]] : [bin, []];
const child = spawn(command, args, {
  env: {
    PATH: process.env.PATH ?? "",
    SEVDESK_API_TOKEN: DUMMY_TOKEN,
    SEVDESK_BASE_URL: "http://127.0.0.1:9/api/v1",
    LOG_LEVEL: "warn",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8").on("data", (chunk) => {
  stderr += chunk;
});
child.on("error", (error) => fail(`cannot start ${bin}: ${error.message}`));

const pending = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(`stdout carried a non-JSON line: ${line.slice(0, 200)}`, stderr);
  }
  pending.get(message.id)?.(message);
});

const exited = new Promise((resolve) =>
  child.on("exit", (code, signal) => resolve({ code, signal })),
);
exited.then(({ code, signal }) => {
  if (pending.size > 0) fail(`binary exited early (code ${code}, signal ${signal})`, stderr);
});

function request(id, method, params = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => fail(`no answer to ${method} within 15s`, stderr), 15_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      pending.delete(id);
      if (message.error) fail(`${method} failed: ${JSON.stringify(message.error)}`, stderr);
      resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const init = await request(1, "initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "smoke-bin", version: "0.0.0" },
});
if (init?.serverInfo?.name !== "sevdesk-mcp") fail(`unexpected serverInfo ${JSON.stringify(init)}`);
if (init.serverInfo.version !== version) {
  fail(`binary reports version ${init.serverInfo.version}, package.json has ${version}`);
}
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const list = await request(2, "tools/list");
const names = (list?.tools ?? []).map((tool) => tool.name);
const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
if (missing.length > 0) fail(`tools/list lacks ${missing.join(", ")}; got ${names.join(", ")}`);

child.stdin.end();
const { code, signal } = await Promise.race([
  exited,
  new Promise((resolve) => setTimeout(() => resolve({ code: "timeout" }), 5_000)),
]);
if (code === "timeout") {
  child.kill("SIGKILL");
  fail("binary did not exit after stdin closed", stderr);
}
if (code !== 0) fail(`binary exited with code ${code} (signal ${signal})`, stderr);
if (stderr.includes(DUMMY_TOKEN)) fail("the token appeared on stderr");

console.error(
  `smoke-bin: ${bin}${arch ? ` (${arch})` : ""} ${version} ok, ${names.length} tools: ${names.join(", ")}`,
);
