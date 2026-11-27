// Starts a compiled binary as an MCP client would, sends initialize and
// tools/list over stdin and checks the answers: once with the defaults, once
// with SEVDESK_MODE=full and the irreversible tools enabled, which must list
// every write tool; then `setup --help` in an empty environment, as install.sh
// probes for it. No network: the token is a dummy and the base URL points at a
// closed local port, and no request reaches sevdesk.
//
//   node scripts/smoke-bin.mjs [path]   default: out/bin/sevdesk-mcp-<host>
//   SMOKE_ARCH=x86_64 node scripts/smoke-bin.mjs out/bin/sevdesk-mcp-darwin-x64
//                                       macOS only: runs the binary under Rosetta
//
// scripts/smoke-mcpb.mjs imports smokeServer and the tool lists from here.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
export const DUMMY_TOKEN = "0123456789abcdef0123456789abcdef";
/** No listener on port 9: a request that slipped through fails instead of reaching sevdesk. */
export const OFFLINE_BASE_URL = "http://127.0.0.1:9/api/v1";
export const EXPECTED_TOOLS = ["get_account_info", "search_invoices", "sevdesk_api_request"];
// Written out: a write tool missing from the binary must fail here. A unit
// test keeps both lists in line with the tool definitions.
export const X_TOOLS = ["send_invoice_email", "cancel_invoice", "enshrine_document"];
export const WRITE_TOOLS = [
  "create_contact",
  "update_contact",
  "create_invoice_draft",
  "create_order_draft",
  "create_invoice_from_order",
  "mark_invoice_sent",
  "book_invoice_payment",
  "create_voucher",
  "tag_document",
  "reset_document_status",
  "book_voucher_payment",
  ...X_TOOLS,
];

export function fail(message, stderr = "") {
  console.error(`smoke: ${message}`);
  if (stderr) console.error(stderr.trimEnd());
  process.exit(1);
}

/**
 * One run of the server: initialize, tools/list, then stdin closes and it must
 * exit 0. env is the server's whole environment, so a real token in the
 * caller's environment cannot reach it. Returns the listed tool names.
 */
export async function smokeServer({ label, command, args, env, expectedTools, version }) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (error) => fail(`${label}: cannot start ${command}: ${error.message}`));

  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`${label}: stdout carried a non-JSON line: ${line.slice(0, 200)}`, stderr);
    }
    pending.get(message.id)?.(message);
  });

  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  exited.then(({ code, signal }) => {
    if (pending.size > 0) {
      fail(`${label}: server exited early (code ${code}, signal ${signal})`, stderr);
    }
  });

  function request(id, method, params = {}) {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => fail(`${label}: no answer to ${method} within 15s`, stderr),
        15_000,
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        if (message.error) {
          fail(`${label}: ${method} failed: ${JSON.stringify(message.error)}`, stderr);
        }
        resolve(message.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  const init = await request(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  if (init?.serverInfo?.name !== "sevdesk-mcp") {
    fail(`${label}: unexpected serverInfo ${JSON.stringify(init)}`);
  }
  if (init.serverInfo.version !== version) {
    fail(`${label}: server reports version ${init.serverInfo.version}, expected ${version}`);
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const list = await request(2, "tools/list");
  const names = (list?.tools ?? []).map((tool) => tool.name);
  const missing = expectedTools.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    fail(`${label}: tools/list lacks ${missing.join(", ")}; got ${names.join(", ")}`);
  }

  child.stdin.end();
  const { code, signal } = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve({ code: "timeout" }), 5_000)),
  ]);
  if (code === "timeout") {
    child.kill("SIGKILL");
    fail(`${label}: server did not exit after stdin closed`, stderr);
  }
  if (code !== 0) fail(`${label}: server exited with code ${code} (signal ${signal})`, stderr);
  if (stderr.includes(DUMMY_TOKEN)) fail(`${label}: the token appeared on stderr`);
  return names;
}

async function main() {
  const host = `${process.platform}-${process.arch}`;
  const bin = process.argv[2] ?? fileURLToPath(new URL(`out/bin/sevdesk-mcp-${host}`, root));
  const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  if (!existsSync(bin)) fail(`${bin} is missing; run "npm run build:bin" first`);

  const arch = process.env.SMOKE_ARCH;
  if (arch !== undefined && !/^[a-z0-9_]+$/.test(arch)) fail(`invalid SMOKE_ARCH ${arch}`);
  const [command, args] = arch ? ["/usr/bin/arch", [`-${arch}`, bin]] : [bin, []];
  // Only what the binary needs; the keychain is never asked because the token is set.
  const env = {
    PATH: process.env.PATH ?? "",
    SEVDESK_API_TOKEN: DUMMY_TOKEN,
    SEVDESK_BASE_URL: OFFLINE_BASE_URL,
    LOG_LEVEL: "warn",
  };

  const defaults = await smokeServer({
    label: "default",
    command,
    args,
    env,
    expectedTools: EXPECTED_TOOLS,
    version,
  });
  const full = await smokeServer({
    label: "full",
    command,
    args,
    env: { ...env, SEVDESK_MODE: "full", SEVDESK_ENABLE_TOOLS: X_TOOLS.join(",") },
    expectedTools: [...EXPECTED_TOOLS, ...WRITE_TOOLS],
    version,
  });

  // install.sh finds the setup command this way: an empty environment, stdin closed.
  const help = spawnSync(command, [...args, "setup", "--help"], {
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 15_000,
  });
  if (help.status !== 0 || !/^Usage: sevdesk-mcp setup/m.test(help.stdout)) {
    fail(`setup --help failed (status ${help.status})`, help.stderr);
  }

  console.error(
    `smoke-bin: ${bin}${arch ? ` (${arch})` : ""} ${version} ok, ${defaults.length} tools by ` +
      `default: ${defaults.join(", ")}; ${full.length} tools in full mode with ${X_TOOLS.join(", ")}; setup --help ok`,
  );
}

// Run directly, not imported. realpath: a symlinked path would otherwise not match and the
// smoke test would pass without running.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
}
