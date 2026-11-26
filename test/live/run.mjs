// Live smoke of the read tools against the real sevdesk API.
//
//   SEVDESK_LIVE_TEST_TOKEN=<token of a sevdesk test account> npm run test:live
//
// Not part of npm run check or CI. Without the token it prints "skipped" and
// exits 0. With it, it builds if needed, starts the server in read mode
// (whatever SEVDESK_MODE says), calls every read tool once with limit 1 and
// prints only tool name, ok or error code, and a count or size. It never
// prints response content and never the token. Exit code 1 if a tool failed.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const token = process.env.SEVDESK_LIVE_TEST_TOKEN?.trim();
if (!token) {
  console.log("live smoke skipped: SEVDESK_LIVE_TEST_TOKEN is not set");
  process.exit(0);
}

const root = fileURLToPath(new URL("../../", import.meta.url));
if (!existsSync(new URL("../../dist/server.js", import.meta.url))) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
}

const dist = (path) => new URL(`../../dist/${path}`, import.meta.url).href;
const { loadConfig } = await import(dist("config.js"));
const { silentLogger } = await import(dist("logger.js"));
const { createPolicyRuntime } = await import(dist("policy/runtime.js"));
const { createServer } = await import(dist("server.js"));
const { createSevdeskClient } = await import(dist("sevdesk/client.js"));
const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");

// Built from an explicit object, not process.env: the mode is always read
// and no other variable of the caller's shell leaks into the run.
const config = loadConfig({
  SEVDESK_API_TOKEN: token,
  SEVDESK_MODE: "read",
  LOG_LEVEL: "error",
  ...(process.env.SEVDESK_BASE_URL && { SEVDESK_BASE_URL: process.env.SEVDESK_BASE_URL }),
});
if (config.mode !== "read") throw new Error("live smoke must run in read mode");

const sevdesk = createSevdeskClient({
  baseUrl: config.baseUrl,
  token: config.sevdeskApiToken,
  logger: silentLogger,
});
const server = createServer(config, {
  logger: silentLogger,
  sevdesk,
  runtime: createPolicyRuntime(config, { transport: "stdio" }),
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "sevdesk-mcp-live-smoke", version: "0" });
await client.connect(clientTransport);

const { tools } = await client.listTools();
const writing = tools.filter((tool) => tool.annotations?.readOnlyHint !== true);
if (writing.length > 0) {
  console.log(`abort: ${writing.length} non-read-only tools registered`);
  process.exit(1);
}

let failures = 0;
const line = (...cells) =>
  console.log(
    cells
      .map((c) => String(c).padEnd(24))
      .join(" ")
      .trimEnd(),
  );

/** Only a status code or a fixed word, never message text. */
function errorCode(result) {
  const text = (result.content ?? []).map((c) => c.text ?? "").join(" ");
  return /\((\d{3})\)/.exec(text)?.[1] ?? (/rate limit/i.test(text) ? "429" : "error");
}

/** Results of a list tool (page.count), 1 for a single object. */
function countOf(data) {
  if (data === undefined || data === null) return 0;
  return typeof data.page?.count === "number" ? data.page.count : 1;
}

async function run(name, args, describe = (data) => `count=${countOf(data)}`) {
  try {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      failures++;
      line(name, "error", errorCode(result));
      return undefined;
    }
    line(name, "ok", describe(result.structuredContent));
    return result.structuredContent;
  } catch (error) {
    failures++;
    line(name, "error", error instanceof Error ? error.name : "exception");
    return undefined;
  }
}

const skip = (name, why) => line(name, "skipped", why);
const firstId = (data, key) => data?.[key]?.[0]?.id;
const today = new Date().toISOString().slice(0, 10);
const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

line("tool", "result", "detail");
await run("get_account_info", {}, () => "count=1");

const contacts = await run("search_contacts", { limit: 1 });
const contactId = firstId(contacts, "contacts");
let embedWorks;
if (contactId) {
  const detail = await run("get_contact", { contactId });
  embedWorks = detail ? detail.note === undefined : undefined;
} else skip("get_contact", "no contact");

const invoices = await run("search_invoices", { limit: 1 });
const invoiceId = firstId(invoices, "invoices");
if (invoiceId) {
  await run("get_invoice", { invoiceId });
  await run(
    "get_document_pdf",
    { documentType: "invoice", documentId: invoiceId },
    (data) => `size=${data.sizeBytes}`,
  );
} else {
  skip("get_invoice", "no invoice");
  skip("get_document_pdf", "no invoice");
}
await run("list_open_receivables", { limit: 1 });
await run("search_orders", { limit: 1 });
const vouchers = await run("search_vouchers", { limit: 1 });
const voucherId = firstId(vouchers, "vouchers");
if (voucherId) await run("get_voucher", { voucherId });
else skip("get_voucher", "no voucher");
await run("list_bank_accounts", { limit: 1 });
await run("search_transactions", { limit: 1 });
await run("search_parts", { limit: 1 });
await run("get_tax_guidance", { limit: 1 });
await run(
  "get_report",
  { report: "invoices", startDate: monthAgo, endDate: today },
  (data) => `size=${data.sizeBytes}`,
);

// Undocumented: does GET /Contact honour a name filter? Probe with the name
// of an existing organisation and a name that cannot exist. Only yes/no is
// printed.
async function nameFilterWorks() {
  const get = (query) =>
    sevdesk.call(sevdesk.api.request("get", `/Contact?${new URLSearchParams(query)}`, {}));
  const sample = await get({ depth: "0", limit: "1", countAll: "true" });
  const name = sample?.objects?.[0]?.name;
  const all = Number(sample?.total);
  if (typeof name !== "string" || name === "" || !(all > 1)) return "unknown (too few contacts)";
  const hit = await get({ depth: "0", name, limit: "100", countAll: "true" });
  const miss = await get({ depth: "0", name: `zz-no-such-${Date.now()}`, countAll: "true" });
  const hits = Number(hit?.total);
  const misses = Number(miss?.total ?? miss?.objects?.length ?? 0);
  return hits >= 1 && hits < all && misses === 0 ? "yes" : "no";
}
let filter;
try {
  filter = await nameFilterWorks();
} catch (error) {
  filter = `unknown (${error?.status ?? (error instanceof Error ? error.name : "error")})`;
}
console.log(`undocumented contact name filter works: ${filter}`);
console.log(
  `contact embed=addresses delivers addresses: ${
    embedWorks === undefined ? "unknown" : embedWorks ? "yes" : "no"
  }`,
);
console.log(failures === 0 ? "live smoke: all tools ok" : `live smoke: ${failures} failed`);

await client.close();
await server.close();
process.exit(failures === 0 ? 0 : 1);
