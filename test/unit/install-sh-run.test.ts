import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Runs install.sh end to end against a stub curl that serves release files from a fixture
// directory, so download, checksum and installation run without network.

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = readFileSync(join(root, "install.sh"), "utf8");
const VERSION = "9.9.9";
const os = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const ASSET = `sevdesk-mcp-${os}-${arch}`;

/** A stand-in binary that answers initialize like the real server. */
function fakeBinary(version: string): string {
  return [
    "#!/bin/sh",
    "read -r _",
    `printf '%s\\n' '{"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"sevdesk-mcp","version":"${version}"}},"jsonrpc":"2.0","id":1}'`,
    "",
  ].join("\n");
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

interface Setup {
  dir: string;
  home: string;
  stubs: string;
  installDir: string;
  curlLog: string;
}

/** Fixture release + stub curl. checksum overrides the SHA256SUMS line of the asset. */
function setup(options: { binaryVersion?: string; checksum?: string } = {}): Setup {
  const dir = mkdtempSync(join(tmpdir(), "sevdesk-mcp-install-"));
  const release = join(dir, "release");
  const stubs = join(dir, "stubs");
  const home = join(dir, "home");
  for (const d of [release, stubs, home]) mkdirSync(d);
  const binary = fakeBinary(options.binaryVersion ?? VERSION);
  writeFileSync(join(release, ASSET), binary);
  writeFileSync(
    join(release, "SHA256SUMS"),
    `${options.checksum ?? sha256(binary)}  ${ASSET}\n${"0".repeat(64)}  sevdesk-mcp-other\n`,
  );
  const curlLog = join(dir, "curl.log");
  // Serves <release>/<basename of the URL>; answers the "latest" lookup with a tag URL.
  writeExecutable(
    join(stubs, "curl"),
    `#!/bin/sh
out=''; url=''; effective=0
while [ $# -gt 0 ]; do
    case "$1" in
        -o) out=$2; shift ;;
        -w) effective=1; shift ;;
        --proto | --proto-redir | --connect-timeout | --retry) shift ;;
        -*) ;;
        *) url=$1 ;;
    esac
    shift
done
echo "$url" >> '${curlLog}'
if [ "$effective" = 1 ]; then printf '%s' "https://github.com/altipard/sevdesk-mcp/releases/tag/${VERSION}"; exit 0; fi
file='${release}'/\${url##*/}
[ -f "$file" ] || exit 22
cp "$file" "$out"
`,
  );
  return { dir, home, stubs, installDir: join(dir, "bin"), curlLog };
}

function install(s: Setup, extraEnv: Record<string, string> = {}) {
  return spawnSync("sh", [join(root, "install.sh"), "--no-setup"], {
    cwd: s.dir,
    encoding: "utf8",
    env: {
      PATH: `${s.stubs}:${process.env.PATH ?? ""}`,
      HOME: s.home,
      INSTALL_DIR: s.installDir,
      LANG: "C",
      TMPDIR: s.dir,
      ...extraEnv,
    },
    timeout: 30_000,
  });
}

describe("install.sh against a stub release", () => {
  it("installs the latest release after checking its checksum", () => {
    const s = setup();
    const result = install(s);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const bin = join(s.installDir, "sevdesk-mcp");
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    expect(result.stdout).toContain(`sevdesk-mcp ${VERSION} installed to ${bin}`);
    expect(result.stdout).toContain("gh attestation verify");
    expect(readFileSync(s.curlLog, "utf8").split("\n")).toEqual([
      "https://github.com/altipard/sevdesk-mcp/releases/latest",
      `https://github.com/altipard/sevdesk-mcp/releases/download/${VERSION}/${ASSET}`,
      `https://github.com/altipard/sevdesk-mcp/releases/download/${VERSION}/SHA256SUMS`,
      "",
    ]);
    // Only the binary, no staging file left behind.
    expect(readdirSync(s.installDir)).toEqual(["sevdesk-mcp"]);

    const again = install(s);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain(`Replaced sevdesk-mcp ${VERSION} with ${VERSION}`);
  });

  it("aborts on a wrong checksum and installs nothing", () => {
    const s = setup({ checksum: "f".repeat(64) });
    const result = install(s, { SEVDESK_MCP_VERSION: VERSION });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    expect(readdirSync(s.installDir)).toEqual([]);
  });

  it("aborts when the binary does not report the release version", () => {
    const s = setup({ binaryVersion: "1.0.0" });
    const result = install(s, { SEVDESK_MCP_VERSION: VERSION });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not run on this system");
    expect(readdirSync(s.installDir)).toEqual([]);
  });

  it("refuses a directory in place of the binary", () => {
    const s = setup();
    mkdirSync(join(s.installDir, "sevdesk-mcp"), { recursive: true });
    const result = install(s, { SEVDESK_MCP_VERSION: VERSION });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is a directory");
    expect(existsSync(s.curlLog)).toBe(false);
  });

  it("stops on musl systems before downloading anything", () => {
    const s = setup();
    writeExecutable(
      join(s.stubs, "uname"),
      '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
    );
    writeExecutable(join(s.stubs, "ldd"), "#!/bin/sh\necho 'musl libc (x86_64)' >&2\nexit 1\n");
    const result = install(s);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npx -y @altipard/sevdesk-mcp");
    expect(existsSync(s.curlLog)).toBe(false);
    expect(existsSync(s.installDir)).toBe(false);
  });
});

describe("install.sh merge_json", () => {
  /** Runs merge_json from install.sh on one file; main is not called. */
  function merge(s: Setup, file: string) {
    const harness = join(s.dir, "merge.sh");
    writeFileSync(
      harness,
      `${script.replace(/\nmain "\$@"\n$/, "\n")}
init_ui
BIN_PATH="$HOME/.local/bin/sevdesk-mcp"
MODE=read
tmp=$(mktemp -d)
merge_json "$1" mcpServers
`,
    );
    return spawnSync("sh", [harness, file], {
      encoding: "utf8",
      env: { PATH: `${s.stubs}:${process.env.PATH ?? ""}`, HOME: s.home, LANG: "C" },
      timeout: 10_000,
    });
  }

  const backups = (dir: string) => readdirSync(dir).filter((name) => name.includes(".backup-"));

  it("adds the server, keeps other entries and leaves a backup of the original", () => {
    const s = setup();
    const file = join(s.home, "mcp.json");
    const original = '{"mcpServers":{"other":{"command":"x"}},"theme":"dark"}\n';
    writeFileSync(file, original);
    chmodSync(file, 0o600);
    const result = merge(s, file);
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      mcpServers: {
        other: { command: "x" },
        sevdesk: { command: join(s.home, ".local/bin/sevdesk-mcp"), env: { SEVDESK_MODE: "read" } },
      },
      theme: "dark",
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const [backup] = backups(s.home);
    expect(readFileSync(join(s.home, backup ?? ""), "utf8")).toBe(original);
    expect(result.stdout).toContain(`backup: ${join(s.home, backup ?? "")}`);
    // No temporary file left next to the configuration.
    expect(readdirSync(s.home).sort()).toEqual([backup, "mcp.json"].sort());
  });

  it("leaves invalid JSON untouched and prints the entry instead", () => {
    const s = setup();
    const file = join(s.home, "mcp.json");
    writeFileSync(file, "{ not json");
    const result = merge(s, file);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
    expect(result.stdout).toContain("not valid JSON");
    expect(result.stdout).toContain('"sevdesk"');
    expect(backups(s.home)).toEqual([]);
  });

  it("restores the backup and names it when the write fails", () => {
    const s = setup();
    const file = join(s.home, "mcp.json");
    const original = '{"mcpServers":{}}\n';
    writeFileSync(file, original);
    writeExecutable(join(s.stubs, "mv"), "#!/bin/sh\nexit 1\n");
    const result = merge(s, file);
    expect(readFileSync(file, "utf8")).toBe(original);
    const [backup] = backups(s.home);
    expect(result.stdout).toContain(`restored it from ${join(s.home, backup ?? "")}`);
    expect(readdirSync(s.home).sort()).toEqual([backup, "mcp.json"].sort());
  });
});
