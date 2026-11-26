#!/usr/bin/env node
import { Transform, type TransformCallback } from "node:stream";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { type Config, ConfigError, forgetSecrets, loadConfig } from "../config.js";
import { resolveApiToken, SECRET_ENV_VARIABLES } from "../keychain.js";
import { createLogger } from "../logger.js";
import { validateToolNames } from "../policy/registry.js";
import { createPolicyRuntime } from "../policy/runtime.js";
import { createServer } from "../server.js";
import { createSevdeskClient } from "../sevdesk/client.js";
import { TOOL_NAMES } from "../tools/index.js";
import { VERSION } from "../version.js";

// stdout carries the MCP protocol. Everything else, including startup
// errors, goes to stderr.

/**
 * Largest JSON-RPC message (one line on stdin) the server reads, in bytes.
 * Sized for create_voucher: a file at its limit travels as base64 (4/3 of
 * its size) plus the JSON envelope. Raise both together.
 */
const STDIO_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/**
 * The SDK transport's own buffer limit. The line limit below hands it at
 * most one message plus its newline at a time; the slack only matters if a
 * stream ever merged chunks. Overflowing it would end the session.
 */
const STDIO_TRANSPORT_BUFFER_BYTES = STDIO_MAX_MESSAGE_BYTES + 1024 * 1024;
/** Bytes kept from the start and end of a dropped line, to find its id. */
const ID_PROBE_BYTES = 512;

const JSON_ID = String.raw`(-?\d{1,16}|"(?:[^"\\]|\\.){0,200}")`;
/** id as the first member, or right after "jsonrpc" (Python clients). */
const ID_AT_START = new RegExp(
  String.raw`^\s*\{\s*(?:"jsonrpc"\s*:\s*"2\.0"\s*,\s*)?"id"\s*:\s*${JSON_ID}\s*[,}]`,
);
/** id as the last member of the top-level object (TypeScript clients). */
const ID_AT_END = new RegExp(String.raw`[{,]\s*"id"\s*:\s*${JSON_ID}\s*\}\s*$`);

/** A request: "method" among the first members (after "jsonrpc" and "id", as clients send them). */
const IS_REQUEST = new RegExp(
  String.raw`^\s*\{\s*(?:"jsonrpc"\s*:\s*"2\.0"\s*,\s*)?(?:"id"\s*:\s*${JSON_ID}\s*,\s*)?"method"\s*:`,
);

/**
 * The id of a request cut off unread, if its start or end names it; else
 * null. Only requests: an oversized response from the client carries an id
 * of the server's own, which must not be answered.
 */
function probeId(head: string, tail: string): string | number | null {
  if (!IS_REQUEST.test(head)) return null;
  const match = ID_AT_START.exec(head) ?? ID_AT_END.exec(tail);
  if (!match?.[1]) return null;
  try {
    const id: unknown = JSON.parse(match[1]);
    return typeof id === "string" || typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Passes stdin to the transport line by line and drops any line over
 * STDIO_MAX_MESSAGE_BYTES. The SDK transport ends the whole session when
 * its buffer overflows; here an oversized message only fails itself: what
 * was already passed on is closed so that it cannot parse (the transport
 * skips it), and a request gets a JSON-RPC error with its id where its
 * start or end shows it.
 */
class MessageSizeLimit extends Transform {
  #length = 0;
  #dropping = false;
  #head: Buffer[] = [];
  #headLength = 0;
  #tail: Buffer = Buffer.alloc(0);

  constructor(private readonly onDropped: (id: string | number | null, bytes: number) => void) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      this.#remember(part);
      this.#length += part.length;
      if (!this.#dropping && this.#length > STDIO_MAX_MESSAGE_BYTES) {
        this.#dropping = true;
        // Ends what the transport already holds of this line, with a byte
        // JSON never contains: a cut that happens to be valid JSON (a whole
        // request followed by padding) must not run.
        this.push(Buffer.from("\u0000\n"));
      }
      if (newline === -1) {
        if (!this.#dropping) this.push(part);
        break;
      }
      if (this.#dropping) {
        this.onDropped(
          probeId(
            Buffer.concat(this.#head).toString("utf8"),
            this.#tail.toString("utf8").replace(/\r$/, ""),
          ),
          this.#length,
        );
      } else {
        // One line per chunk: the transport never buffers more than one message.
        this.push(chunk.subarray(start, newline + 1));
      }
      this.#length = 0;
      this.#dropping = false;
      this.#head = [];
      this.#headLength = 0;
      this.#tail = Buffer.alloc(0);
      start = newline + 1;
    }
    done();
  }

  #remember(part: Buffer): void {
    if (this.#headLength < ID_PROBE_BYTES) {
      const take = part.subarray(0, ID_PROBE_BYTES - this.#headLength);
      this.#head.push(Buffer.from(take));
      this.#headLength += take.length;
    }
    this.#tail =
      part.length >= ID_PROBE_BYTES
        ? Buffer.from(part.subarray(part.length - ID_PROBE_BYTES))
        : Buffer.concat([this.#tail, part]).subarray(-ID_PROBE_BYTES);
  }
}

// Without SEVDESK_API_TOKEN the token comes from the system keychain, so it
// does not have to sit in a client configuration file.
const token = await resolveApiToken(process.env);

let config: Config;
try {
  config = loadConfig(token.env);
  // token.env is process.env itself, or a copy holding the keychain token.
  // Afterwards code running in this process cannot read the secrets from
  // the environment, and child processes do not inherit them.
  forgetSecrets(SECRET_ENV_VARIABLES, process.env, token.env);
  validateToolNames(config, TOOL_NAMES);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`sevdesk-mcp: ${error.message}\n`);
    // Keychain details only help when the token is the problem.
    if (error.issues.some((issue) => issue.startsWith("SEVDESK_API_TOKEN:"))) {
      if (token.source === "keychain") {
        process.stderr.write("sevdesk-mcp: the token was read from the keychain\n");
      } else if (token.keychainNote) {
        process.stderr.write(`sevdesk-mcp: ${token.keychainNote}\n`);
      }
    }
    process.exit(1);
  }
  throw error;
}

const secrets = [config.sevdeskApiToken, ...(config.confirmSecret ? [config.confirmSecret] : [])];
const logger = createLogger({ level: config.logLevel, redact: secrets });
const sevdesk = createSevdeskClient({
  baseUrl: config.baseUrl,
  token: config.sevdeskApiToken,
  logger,
});
// Once per process: without SEVDESK_CONFIRM_SECRET the HMAC key is random
// and confirmation tokens end with the process; the nonce store is shared
// by every server instance serveStdio builds.
const runtime = createPolicyRuntime(config, { transport: "stdio" });

const stdin = new MessageSizeLimit((id, bytes) => {
  logger.warn("stdio message over the size limit dropped", {
    bytes,
    limit: STDIO_MAX_MESSAGE_BYTES,
  });
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: `Message too large: a single message must not exceed ${STDIO_MAX_MESSAGE_BYTES} bytes`,
      },
    })}\n`,
  );
});
process.stdin.on("error", (error) => stdin.destroy(error));
process.stdin.pipe(stdin);

const handle = serveStdio(() => createServer(config, { logger, sevdesk, runtime }), {
  transport: new StdioServerTransport(stdin, process.stdout, {
    maxBufferSize: STDIO_TRANSPORT_BUFFER_BYTES,
  }),
  onerror: (error) => logger.error("stdio transport error", { error }),
});

logger.info("sevdesk-mcp started", {
  version: VERSION,
  transport: "stdio",
  mode: config.mode,
  tokenSource: token.source,
});

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("sevdesk-mcp stopping", { signal });
  handle.close().then(
    () => process.exit(0),
    (error: unknown) => {
      logger.error("shutdown failed", { error });
      process.exit(1);
    },
  );
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
