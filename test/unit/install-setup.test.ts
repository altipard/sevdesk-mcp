import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Runs the interactive setup of install.sh (setup and the functions it calls) without main and
// without a terminal: the harness points the terminal at files, and stubs stand in for the
// keychain tools, curl, stty and the client CLIs. Nothing real is called: PATH holds only the
// stubs, /usr/bin and /bin, and every tool the setup may run from there is stubbed. A client
// CLI installed in /usr/bin or /bin would be detected and run, so the tests skip on such a
// system.

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = readFileSync(join(root, "install.sh"), "utf8");
const TOKEN = "0123456789abcdef0123456789ABCDEF";

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

const realClient = ["claude", "code", "cursor"].some(
  (cli) => existsSync(`/usr/bin/${cli}`) || existsSync(`/bin/${cli}`),
);

/** jq or python3 from the developer's PATH, for merge_json. */
const merger = spawnSync("sh", ["-c", "command -v jq || command -v python3"], {
  encoding: "utf8",
}).stdout.trim();

interface Env {
  dir: string;
  home: string;
  stubs: string;
  log: string;
  ttyIn: string;
  ttyOut: string;
}

interface Options {
  os?: "darwin" | "linux";
  /** Client CLIs on PATH. */
  clis?: ("claude" | "code")[];
  /** A token is already in the keychain. */
  stored?: boolean;
  /** HTTP status the stub curl reports for the token check; "fail" = no connection. */
  http?: string;
  secretTool?: boolean;
}

/** Each stub appends "<name> <args>" to the call log. */
function stub(env: Env, name: string, body = "") {
  writeExecutable(
    join(env.stubs, name),
    `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${env.log}'\n${body}\n`,
  );
}

function prepare(options: Options = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), "sevdesk-mcp-setup-"));
  const env: Env = {
    dir,
    home: join(dir, "home"),
    stubs: join(dir, "stubs"),
    log: join(dir, "calls.log"),
    ttyIn: join(dir, "tty.in"),
    ttyOut: join(dir, "tty.out"),
  };
  mkdirSync(env.home);
  mkdirSync(env.stubs);
  writeFileSync(env.log, "");
  const saveStdin = (name: string) => `cat >> '${join(dir, `${name}.stdin`)}'`;
  stub(
    env,
    "security",
    `case "$1" in
    find-generic-password) exit ${options.stored ? 0 : 44} ;;
    -i) ${saveStdin("security")} ;;
esac`,
  );
  if (options.secretTool !== false) {
    stub(
      env,
      "secret-tool",
      `case "$1" in
    lookup) exit ${options.stored ? 0 : 1} ;;
    store) ${saveStdin("secret-tool")} ;;
esac`,
    );
  }
  const http = options.http ?? "200";
  stub(
    env,
    "curl",
    `${saveStdin("curl")}\n${http === "fail" ? "printf 000; exit 7" : `printf '%s' '${http}'`}`,
  );
  stub(env, "stty", `case "$1" in -g) printf 'saved-state\\n' ;; esac`);
  for (const cli of options.clis ?? []) stub(env, cli);
  if (merger) symlinkSync(merger, join(env.stubs, merger.split("/").at(-1) ?? "jq"));
  return env;
}

function harness(env: Env, options: Options, extra: string) {
  const path = join(env.dir, "setup.sh");
  writeFileSync(
    path,
    `${script.replace(/\nmain "\$@"\n$/, "\n")}
init_ui
OS=${options.os ?? "darwin"}
TTY_IN='${env.ttyIn}'
TTY_OUT='${env.ttyOut}'
MAC_APPS='${join(env.dir, "Applications")}'
BIN_PATH="$HOME/.local/bin/sevdesk-mcp"
MODE=\${MODE:-read}
REPLACE_TOKEN=\${REPLACE_TOKEN:-0}
VERIFY_TOKEN=\${VERIFY_TOKEN:-1}
tmp=$(mktemp -d)
trap cleanup EXIT
trap 'exit 130' INT
${extra}
`,
  );
  return path;
}

function harnessEnv(env: Env, vars: Record<string, string>) {
  return {
    PATH: `${env.stubs}:/usr/bin:/bin`,
    HOME: env.home,
    LANG: "C",
    TMPDIR: env.dir,
    ...vars,
  };
}

/** Runs setup with the given terminal input lines. */
function runSetup(
  env: Env,
  input: string[],
  options: Options = {},
  vars: Record<string, string> = {},
) {
  writeFileSync(env.ttyIn, input.map((line) => `${line}\n`).join(""));
  const result = spawnSync("sh", [harness(env, options, "setup")], {
    encoding: "utf8",
    env: harnessEnv(env, vars),
    timeout: 20_000,
  });
  const read = (name: string) => {
    const file = join(env.dir, name);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  return {
    ...result,
    tty: read("tty.out"),
    calls: read("calls.log"),
    securityStdin: read("security.stdin"),
    secretToolStdin: read("secret-tool.stdin"),
    curlStdin: read("curl.stdin"),
  };
}

const desktopConfig = (env: Env) =>
  join(env.home, "Library/Application Support/Claude/claude_desktop_config.json");

describe.skipIf(realClient)("install.sh setup", () => {
  it("shows one plan for the detected clients and carries it out after a single confirmation", () => {
    const env = prepare({ clis: ["claude"] });
    mkdirSync(dirname(desktopConfig(env)), { recursive: true });
    const result = runSetup(env, ["", TOKEN], { clis: ["claude"] });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("token:   ask for it once and store it in the macOS keychain");
    expect(result.stdout).toContain("mode:    read");
    expect(result.stdout).toContain("clients: Claude Desktop, Claude Code\n");
    expect(result.stdout).toContain("Not found: Cursor, VS Code.");
    // The only question is the confirmation; the rest is the hidden token prompt.
    expect(result.tty.match(/\[[Yy]\/[Nn]\]/g)).toEqual(["[Y/n]"]);
    expect(result.tty).toContain("Paste your sevdesk API token");

    expect(JSON.parse(readFileSync(desktopConfig(env), "utf8"))).toEqual({
      mcpServers: {
        sevdesk: {
          command: join(env.home, ".local/bin/sevdesk-mcp"),
          env: { SEVDESK_MODE: "read" },
        },
      },
    });
    const bin = join(env.home, ".local/bin/sevdesk-mcp");
    expect(result.calls).toContain("claude mcp remove --scope user sevdesk\n");
    expect(result.calls).toContain(
      `claude mcp add --scope user sevdesk --env SEVDESK_MODE=read -- ${bin}\n`,
    );
    // Clients that are not installed get no configuration.
    expect(existsSync(join(env.home, ".cursor"))).toBe(false);
    expect(result.calls).not.toMatch(/^code /m);
  });

  it("detects Cursor and Claude Desktop from their application bundles", () => {
    const env = prepare({ clis: ["code"] });
    mkdirSync(join(env.dir, "Applications/Cursor.app"), { recursive: true });
    mkdirSync(join(env.home, "Applications/Claude.app"), { recursive: true });
    const result = runSetup(env, ["n"], { clis: ["code"] });
    expect(result.stdout).toContain("clients: Claude Desktop, Cursor, VS Code\n");
  });

  it("passes the token on stdin only, never as an argument or in the output", () => {
    const env = prepare();
    const result = runSetup(env, ["y", `  ${TOKEN}\r`]);
    expect(result.status).toBe(0);
    expect(result.securityStdin).toBe(
      `add-generic-password -U -s sevdesk-mcp -a api-token -l sevdesk-mcp -w ${TOKEN}\n`,
    );
    expect(result.curlStdin).toBe(`header = "Authorization: ${TOKEN}"\n`);
    expect(result.calls).toContain("curl -sS -K - ");
    expect(result.calls).toContain("security -i\n");
    expect(result.calls).not.toContain(TOKEN);
    expect(result.stdout + result.stderr + result.tty).not.toContain(TOKEN);
    expect(result.stdout).toContain("sevdesk accepted the token.");
    expect(result.stdout).toContain("Token stored in the macOS keychain");
    expect(result.stdout).toContain("clients: none found");
    // Echo is switched off for the token and restored afterwards.
    expect(result.calls).toContain("stty -g\nstty -echo\nstty saved-state\n");
  });

  it("stores the token with secret-tool on Linux", () => {
    const env = prepare({ os: "linux" });
    const result = runSetup(env, ["", TOKEN], { os: "linux" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("store it in the keychain (Secret Service)");
    expect(result.secretToolStdin).toBe(TOKEN);
    expect(result.calls).toContain(
      "secret-tool store --label=sevdesk-mcp service sevdesk-mcp account api-token\n",
    );
    expect(result.calls).not.toContain(TOKEN);
  });

  it("changes nothing when the plan is declined", () => {
    const env = prepare({ clis: ["claude", "code"] });
    mkdirSync(join(env.home, ".cursor"));
    const result = runSetup(env, ["n"], { clis: ["claude", "code"] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("clients: Claude Code, Cursor, VS Code\n");
    expect(result.stdout).toContain("Skipped; nothing was changed.");
    expect(result.stdout).toContain("security add-generic-password -U -s sevdesk-mcp");
    expect(result.calls).not.toMatch(/^(claude|code|curl|stty) /m);
    expect(result.calls).not.toContain("security -i");
    expect(existsSync(join(env.home, ".cursor/mcp.json"))).toBe(false);
  });

  it("takes a closed terminal as no", () => {
    const env = prepare({ clis: ["claude"] });
    mkdirSync(join(env.home, ".cursor"));
    const result = runSetup(env, [], { clis: ["claude"] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skipped; nothing was changed.");
    expect(result.calls).not.toMatch(/^(claude|curl|stty) /m);
    expect(existsSync(join(env.home, ".cursor/mcp.json"))).toBe(false);
  });

  it("asks again for input that is not a 32-hex token", () => {
    const env = prepare();
    const result = runSetup(env, ["", "not-a-token", TOKEN.slice(1), TOKEN]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("expected 32 hex characters, got 11.");
    expect(result.stdout).toContain("expected 32 hex characters, got 31.");
    expect(result.securityStdin).toContain(`-w ${TOKEN}\n`);
    expect(result.curlStdin).toBe(`header = "Authorization: ${TOKEN}"\n`);
  });

  it("gives up after three malformed tokens without touching the keychain", () => {
    const env = prepare();
    const result = runSetup(env, ["", "x", "y", "z", TOKEN]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No valid token after three attempts");
    expect(result.stdout).toContain("No token in the keychain");
    expect(result.securityStdin).toBe("");
  });

  it("refuses a token sevdesk rejects and asks again", () => {
    const env = prepare({ http: "401" });
    const result = runSetup(env, ["", TOKEN, TOKEN, TOKEN], { http: "401" });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/sevdesk rejected this token \(HTTP 401\)/g)).toHaveLength(3);
    expect(result.securityStdin).toBe("");
  });

  it("stores the token anyway when sevdesk cannot be reached", () => {
    const env = prepare({ http: "fail" });
    const result = runSetup(env, ["", TOKEN], { http: "fail" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Could not check the token with sevdesk (HTTP 000)");
    expect(result.securityStdin).toContain(`-w ${TOKEN}\n`);
  });

  it("skips the check with --no-verify", () => {
    const env = prepare({ http: "401" });
    const result = runSetup(env, ["", TOKEN], { http: "401" }, { VERIFY_TOKEN: "0" });
    expect(result.status).toBe(0);
    expect(result.calls).not.toMatch(/^curl /m);
    expect(result.securityStdin).toContain(`-w ${TOKEN}\n`);
  });

  it("keeps a stored token unless --replace-token is given", () => {
    const kept = prepare({ stored: true });
    const keep = runSetup(kept, [""], { stored: true });
    expect(keep.status).toBe(0);
    expect(keep.stdout).toContain("keep the one already in the macOS keychain");
    expect(keep.tty).not.toContain("Paste your sevdesk API token");
    expect(keep.stdout).toContain("The server reads the token from the keychain");

    const replaced = prepare({ stored: true });
    const replace = runSetup(replaced, ["", TOKEN], { stored: true }, { REPLACE_TOKEN: "1" });
    expect(replace.stdout).toContain("ask for it once and store it");
    expect(replace.securityStdin).toContain(`-w ${TOKEN}\n`);
  });

  it("writes the requested mode into the client entries", () => {
    const env = prepare();
    mkdirSync(join(env.home, ".cursor"));
    const result = runSetup(env, ["", ""], {}, { MODE: "write" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mode:    write\n");
    expect(result.stdout).toContain("No token entered");
    const config = JSON.parse(readFileSync(join(env.home, ".cursor/mcp.json"), "utf8"));
    expect(config.mcpServers.sevdesk.env).toEqual({ SEVDESK_MODE: "write" });
  });

  // A real secret-tool in /usr/bin or /bin would be found.
  it.skipIf(existsSync("/usr/bin/secret-tool") || existsSync("/bin/secret-tool"))(
    "explains a missing secret-tool in the plan",
    () => {
      const env = prepare({ os: "linux", secretTool: false });
      const result = runSetup(env, [""], { os: "linux", secretTool: false });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "token:   not stored: secret-tool (libsecret) is not installed",
      );
      expect(result.tty).not.toContain("Paste your sevdesk API token");
    },
  );

  it("restores the terminal when interrupted during the hidden token prompt", async () => {
    const env = prepare();
    const fifo = join(env.dir, "tty.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const path = harness(
      env,
      {},
      `TTY_IN='${fifo}'
open_tty
read_secret "token:"
echo "read returned" >&2`,
    );
    const child = spawn("sh", [path], { env: harnessEnv(env, {}), stdio: "ignore" });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    // Opening a FIFO for reading blocks until a writer exists; keep one open and write nothing.
    const writer = openSync(fifo, "w");
    try {
      const deadline = Date.now() + 10_000;
      while (!readFileSync(env.log, "utf8").includes("stty -echo")) {
        if (Date.now() > deadline) throw new Error("stty -echo never ran");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      child.kill("SIGINT");
      expect(await exited).toBe(130);
    } finally {
      closeSync(writer);
    }
    expect(readFileSync(env.log, "utf8")).toBe("stty -g\nstty -echo\nstty saved-state\n");
  });
});
