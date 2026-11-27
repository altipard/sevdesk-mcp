import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The hand-off from install.sh to `sevdesk-mcp setup`: the probe that tells a binary with the
// setup command from an older one, and run_setup, which starts it on the terminal with the
// installer's options. The functions run without main; files stand in for the terminal and a
// stub stands in for the installed binary. The guided setup itself is tested in setup*.test.ts.

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = readFileSync(join(root, "install.sh"), "utf8");

interface Env {
  dir: string;
  bin: string;
  ttyIn: string;
  ttyOut: string;
}

/**
 * A stub binary. With setup: `setup --help` prints the usage line and records its environment,
 * `setup ...` records its arguments and terminal input and exits with `exit`. Without setup it
 * behaves like an older release: it ignores the arguments and serves on stdin.
 */
function prepare(options: { setup?: boolean; exit?: number } = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), "sevdesk-mcp-handoff-"));
  const env: Env = {
    dir,
    bin: join(dir, "sevdesk-mcp"),
    ttyIn: join(dir, "tty.in"),
    ttyOut: join(dir, "tty.out"),
  };
  writeFileSync(env.ttyIn, "answers from the terminal\n");
  writeFileSync(env.ttyOut, "");
  const setup = options.setup ?? true;
  writeFileSync(
    env.bin,
    `#!/bin/sh
${
  setup
    ? `if [ "$1" = setup ]; then
    if [ "$2" = --help ]; then
        env > '${join(dir, "probe.env")}'
        echo 'Usage: sevdesk-mcp setup [options]'
        exit 0
    fi
    printf '%s\\n' "$*" > '${join(dir, "args")}'
    cat > '${join(dir, "stdin")}'
    echo 'setup ran'
    exit ${options.exit ?? 0}
fi`
    : ""
}
echo started > '${join(dir, "served")}'
cat >/dev/null
`,
  );
  chmodSync(env.bin, 0o755);
  return env;
}

/** Runs install.sh's functions without main, then `body`. */
function run(env: Env, body: string, vars: Record<string, string> = {}) {
  const harness = join(env.dir, "harness.sh");
  writeFileSync(
    harness,
    `${script.replace(/\nmain "\$@"\n$/, "\n")}
init_ui
OS=darwin
TTY_IN='${env.ttyIn}'
TTY_OUT='${env.ttyOut}'
BIN_PATH='${env.bin}'
MODE=\${MODE:-read}
MODE_FLAG=\${MODE_FLAG:-0}
REPLACE_TOKEN=\${REPLACE_TOKEN:-0}
REPLACE_ENTRIES=\${REPLACE_ENTRIES:-0}
VERIFY_TOKEN=\${VERIFY_TOKEN:-1}
tmp=$(mktemp -d)
set_traps
${body}
echo "harness done"
`,
  );
  const result = spawnSync("sh", [harness], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: env.dir, LANG: "C", TMPDIR: env.dir, ...vars },
    timeout: 20_000,
  });
  const read = (name: string) =>
    existsSync(join(env.dir, name)) ? readFileSync(join(env.dir, name), "utf8") : undefined;
  return { ...result, read, tty: readFileSync(env.ttyOut, "utf8") };
}

describe("install.sh supports_setup", () => {
  it("finds the setup command from its usage line, in a bare environment with a dummy token", () => {
    const env = prepare();
    const result = run(env, "if supports_setup; then echo yes; else echo no; fi");
    expect(result.stdout).toContain("yes");
    const probe = result.read("probe.env") ?? "";
    expect(probe).toContain("SEVDESK_API_TOKEN=00000000000000000000000000000000");
    expect(probe).toContain("SEVDESK_BASE_URL=http://127.0.0.1:9/api/v1");
    // env -i: nothing of the installer's environment, not even HOME.
    expect(probe).not.toMatch(/^HOME=/m);
  });

  it("tells an older release apart without leaving it running", () => {
    const env = prepare({ setup: false });
    const result = run(env, "if supports_setup; then echo yes; else echo no; fi");
    expect(result.stdout).toContain("no");
    // It started as a server on closed stdin and ended by itself.
    expect(result.read("served")).toBe("started\n");
    expect(result.stdout).toContain("harness done");
  });
});

describe("install.sh run_setup", () => {
  it("runs the setup on the terminal, without --mode unless one was given", () => {
    const env = prepare();
    const result = run(env, "run_setup");
    expect(result.status).toBe(0);
    expect(result.read("args")).toBe("setup\n");
    expect(result.read("stdin")).toBe("answers from the terminal\n");
    expect(result.tty).toBe("setup ran\n");
  });

  it("passes the installer's options on", () => {
    const env = prepare();
    const result = run(env, "run_setup", {
      MODE: "write",
      MODE_FLAG: "1",
      REPLACE_TOKEN: "1",
      REPLACE_ENTRIES: "1",
      VERIFY_TOKEN: "0",
    });
    expect(result.read("args")).toBe(
      "setup --mode=write --replace-token --replace-entries --no-verify\n",
    );
  });

  it("passes a mode from SEVDESK_MODE on", () => {
    const env = prepare();
    const result = run(env, "MODE=$SEVDESK_MODE; run_setup", { SEVDESK_MODE: "full" });
    expect(result.read("args")).toBe("setup --mode=full\n");
  });

  it("reports a cancelled setup without failing the installation", () => {
    const env = prepare({ exit: 130 });
    const result = run(env, "run_setup");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Setup cancelled. Run it again any time: ${env.bin} setup`);
    expect(result.stdout).toContain("harness done");
  });

  it("reports a failed setup without failing the installation", () => {
    const env = prepare({ exit: 1 });
    const result = run(env, "run_setup");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `The setup did not finish (exit 1). Run it again: ${env.bin} setup`,
    );
  });
});

describe("install.sh print_next_steps", () => {
  it("points at the setup command when the binary has it", () => {
    const env = prepare();
    const result = run(env, "SETUP_CMD=1; print_next_steps");
    expect(result.stdout).toContain(`${env.bin} setup`);
    expect(result.stdout).not.toContain("security add-generic-password");
  });

  it("falls back to the manual steps for an older release", () => {
    const env = prepare({ setup: false });
    const result = run(env, "SETUP_CMD=0; print_next_steps");
    expect(result.stdout).toContain(
      "security add-generic-password -U -s sevdesk-mcp -a api-token -w",
    );
    expect(result.stdout).toContain(`point your MCP client at ${env.bin}`);
  });
});

describe("install.sh terminal_device", () => {
  /** Runs terminal_device with TTY_IN=/dev/tty and a stub ps that prints `tty`. */
  function device(tty: string) {
    const env = prepare();
    const stubs = join(env.dir, "stubs");
    mkdirSync(stubs);
    writeFileSync(join(stubs, "ps"), `#!/bin/sh\nprintf '%s\\n' '${tty}'\n`);
    chmodSync(join(stubs, "ps"), 0o755);
    return run(env, 'TTY_IN=/dev/tty; terminal_device; echo "dev=$TTY_DEV"', {
      PATH: `${stubs}:/usr/bin:/bin`,
    }).stdout;
  }

  it("keeps a test terminal file as it is", () => {
    const env = prepare();
    expect(run(env, 'terminal_device; echo "dev=$TTY_DEV"').stdout).toContain(`dev=${env.ttyIn}`);
  });

  it.each(["??", "?", "", "ttys0;rm", "../etc/passwd", "no-such-tty-device"])(
    "falls back to /dev/tty for %j",
    (tty) => {
      expect(device(tty)).toContain("dev=/dev/tty\n");
    },
  );

  it("takes the device behind the terminal when it exists", () => {
    // /dev/null is a character device anyone may read and write.
    expect(device("null")).toContain("dev=/dev/null\n");
  });
});
