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

/**
 * Fixture release + stub curl. checksum overrides the SHA256SUMS line of the asset, latestUrl
 * the URL the "latest" lookup ends at.
 */
function setup(
  options: { binaryVersion?: string; checksum?: string; latestUrl?: string } = {},
): Setup {
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
if [ "$effective" = 1 ]; then printf '%s' "${options.latestUrl ?? `https://github.com/altipard/sevdesk-mcp/releases/tag/${VERSION}`}"; exit 0; fi
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
    expect(again.stdout).toContain(`Replaced the existing ${bin} with sevdesk-mcp ${VERSION}`);
  });

  it("says so when no release is published yet", () => {
    const s = setup({ latestUrl: "https://github.com/altipard/sevdesk-mcp/releases" });
    const result = install(s);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no release published yet");
    expect(result.stderr).toContain("npx -y @altipard/sevdesk-mcp");
    expect(readFileSync(s.curlLog, "utf8")).toBe(
      "https://github.com/altipard/sevdesk-mcp/releases/latest\n",
    );
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

  it("replaces an existing file without running it", () => {
    const s = setup();
    mkdirSync(s.installDir);
    const marker = join(s.dir, "ran");
    writeExecutable(join(s.installDir, "sevdesk-mcp"), `#!/bin/sh\ntouch '${marker}'\n`);
    const result = install(s, { SEVDESK_MCP_VERSION: VERSION });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Replaced the existing");
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(s.installDir, "sevdesk-mcp"), "utf8")).toBe(fakeBinary(VERSION));
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
