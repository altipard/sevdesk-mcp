import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Runs install.sh end to end against a stub curl that serves release files from a fixture
// directory, so download, checksum, unpacking and installation run without network.

const root = fileURLToPath(new URL("../../", import.meta.url));
const VERSION = "9.9.9";

/** { os, arch } as uname would report them on this machine. */
const hostPlatform = {
  os: process.platform === "darwin" ? "Darwin" : "Linux",
  arch: process.arch === "arm64" ? "arm64" : "x86_64",
};

/** The asset names install.sh derives from { os, arch }: sevdesk-mcp-<os>-<arch>[.tar.xz]. */
function assetNames(platform: { os: string; arch: string }) {
  const os = platform.os === "Darwin" ? "darwin" : "linux";
  const arch = platform.arch === "arm64" || platform.arch === "aarch64" ? "arm64" : "x64";
  const asset = `sevdesk-mcp-${os}-${arch}`;
  return { asset, archive: `${asset}.tar.xz` };
}

/** A stand-in binary that answers initialize like the real server. */
function fakeBinary(version: string): string {
  return [
    "#!/bin/sh",
    "read -r _",
    `printf '%s\\n' '{"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"sevdesk-mcp","version":"${version}"}},"jsonrpc":"2.0","id":1}'`,
    "",
  ].join("\n");
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

interface TarMember {
  name: string;
  data?: string;
  type?: "file" | "symlink" | "dir";
  linkname?: string;
  mode?: string;
}

/**
 * USTAR bytes with exactly these members. Crafted by hand rather than packed with the host
 * tar: both tar implementations refuse to *store* names like "../evil", while these tests
 * need archives that hold them, and both read plain USTAR back.
 */
function ustar(members: TarMember[]): Buffer {
  const blocks: Buffer[] = [];
  for (const m of members) {
    const data = Buffer.from(m.data ?? "");
    const header = Buffer.alloc(512);
    header.write(m.name, 0, 100, "latin1");
    header.write(`${(m.mode ?? "644").padStart(7, "0")}\0`, 100, 8, "latin1");
    header.write("0000000\0", 108, 8, "latin1");
    header.write("0000000\0", 116, 8, "latin1");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
    header.write("00000000000\0", 136, 12, "latin1");
    header.write("        ", 148, 8, "latin1"); // checksum placeholder while summing
    header.write(m.type === "symlink" ? "2" : m.type === "dir" ? "5" : "0", 156, 1, "latin1");
    header.write(m.linkname ?? "", 157, 100, "latin1");
    header.write("ustar\0", 257, 6, "latin1");
    header.write("00", 263, 2, "latin1");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
    blocks.push(header);
    if (data.length > 0) {
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** A real tar.xz with one member "sevdesk-mcp" holding these bytes, packed by the host tar. */
function tarXz(dir: string, content: string): Buffer {
  const stage = mkdtempSync(join(dir, "stage-"));
  writeExecutable(join(stage, "sevdesk-mcp"), content);
  const archive = join(mkdtempSync(join(dir, "packed-")), "out.tar.xz");
  execFileSync("tar", ["-cJf", archive, "-C", stage, "sevdesk-mcp"]);
  return readFileSync(archive);
}

interface Setup {
  dir: string;
  home: string;
  stubs: string;
  installDir: string;
  curlLog: string;
  asset: string;
  archive: string;
}

interface SetupOptions {
  /** binaryVersion: what the fake binary reports; checksum overrides the SHA256SUMS line of
   * the asset; latestUrl the URL the "latest" lookup ends at. archive: "valid" packs the
   * binary with the host tar, a Buffer serves raw bytes under the .tar.xz name (for crafted
   * archives); archiveChecksum overrides the archive's line. No archive option: the release
   * has none, like before the .tar.xz assets existed. platform stubs uname, to exercise
   * another platform's path. */
  binaryVersion?: string;
  checksum?: string;
  latestUrl?: string;
  archive?: "valid" | Buffer;
  archiveChecksum?: string;
  platform?: { os: string; arch: string };
}

/** Fixture release + stub curl serving <release>/<basename of the URL>. */
function setup(options: SetupOptions = {}): Setup {
  const dir = mkdtempSync(join(tmpdir(), "sevdesk-mcp-install-"));
  const release = join(dir, "release");
  const stubs = join(dir, "stubs");
  const home = join(dir, "home");
  for (const d of [release, stubs, home]) mkdirSync(d);
  const platform = options.platform ?? hostPlatform;
  const { asset, archive } = assetNames(platform);
  const binary = fakeBinary(options.binaryVersion ?? VERSION);
  writeFileSync(join(release, asset), binary);
  let sums = `${options.checksum ?? sha256(binary)}  ${asset}\n${"0".repeat(64)}  sevdesk-mcp-other\n`;
  if (options.archive) {
    const bytes = options.archive === "valid" ? tarXz(dir, binary) : options.archive;
    writeFileSync(join(release, archive), bytes);
    sums += `${options.archiveChecksum ?? sha256(bytes)}  ${archive}\n`;
  }
  writeFileSync(join(release, "SHA256SUMS"), sums);
  if (options.platform) {
    writeExecutable(
      join(stubs, "uname"),
      `#!/bin/sh\ncase "$1" in -s) echo ${options.platform.os} ;; -m) echo ${options.platform.arch} ;; esac\n`,
    );
    if (options.platform.os === "Linux") {
      writeExecutable(join(stubs, "ldd"), "#!/bin/sh\necho 'ldd (Ubuntu GLIBC 2.39) 2.39'\n");
    }
  }
  const curlLog = join(dir, "curl.log");
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
  return { dir, home, stubs, installDir: join(dir, "bin"), curlLog, asset, archive };
}

/** The tools install.sh runs directly; symlinked into one directory so a test can leave
 * some out and thereby simulate a system without them (e.g. Linux without xz). */
const CORE_TOOLS = [
  "awk",
  "cat",
  "chmod",
  "cp",
  "env",
  "grep",
  "head",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "rm",
  "sed",
  "sha256sum",
  "shasum",
  "sleep",
  "tar",
  "xz",
];

function coreDir(s: Setup, exclude: string[]): string {
  const dir = join(s.dir, "core");
  mkdirSync(dir, { recursive: true });
  for (const tool of CORE_TOOLS) {
    if (exclude.includes(tool)) continue;
    const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], {
      encoding: "utf8",
    }).stdout.trim();
    if (found && !existsSync(join(dir, tool))) symlinkSync(found, join(dir, tool));
  }
  return dir;
}

/** Run the installer; excludeTools replaces PATH with the stubs plus symlinked core tools. */
function install(
  s: Setup,
  extraEnv: Record<string, string> = {},
  opts: { excludeTools?: string[] } = {},
) {
  const path = opts.excludeTools
    ? `${s.stubs}:${coreDir(s, opts.excludeTools)}`
    : `${s.stubs}:${process.env.PATH ?? ""}`;
  return spawnSync("/bin/sh", [join(root, "install.sh"), "--no-setup"], {
    cwd: s.dir,
    encoding: "utf8",
    env: {
      PATH: path,
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
  // SHA256SUMS lists no .tar.xz here: releases from before the archives keep working and
  // get the single binary. The checksums come first now, so the installer can choose.
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
      `https://github.com/altipard/sevdesk-mcp/releases/download/${VERSION}/SHA256SUMS`,
      `https://github.com/altipard/sevdesk-mcp/releases/download/${VERSION}/${s.asset}`,
      "",
    ]);
    // Only the binary, no staging file left behind.
    expect(readdirSync(s.installDir)).toEqual(["sevdesk-mcp"]);

    const again = install(s);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain(`Replaced the existing ${bin} with sevdesk-mcp ${VERSION}`);
  });

  it("prefers the tar.xz archive when SHA256SUMS lists one", () => {
    const s = setup({ archive: "valid" });
    const result = install(s, { SEVDESK_MCP_VERSION: VERSION });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const bin = join(s.installDir, "sevdesk-mcp");
    expect(readFileSync(bin, "utf8")).toBe(fakeBinary(VERSION));
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    // Only the archive is fetched, never the plain binary.
    expect(readFileSync(s.curlLog, "utf8").split("\n")).toEqual([
      `https://github.com/altipard/sevdesk-mcp/releases/download/${VERSION}/SHA256SUMS`,
      `https://github.com/altipard/sevdesk-mcp/releases/download/${VERSION}/${s.archive}`,
      "",
    ]);
    expect(readdirSync(s.installDir)).toEqual(["sevdesk-mcp"]);
  });

  it("unpacks the archive on Linux when xz is in PATH", () => {
    const s = setup({ archive: "valid", platform: { os: "Linux", arch: hostPlatform.arch } });
    const result = install(s, { SEVDESK_MCP_VERSION: VERSION });
    expect(result.status).toBe(0);
    expect(readFileSync(join(s.installDir, "sevdesk-mcp"), "utf8")).toBe(fakeBinary(VERSION));
    expect(readFileSync(s.curlLog, "utf8")).toContain(`/${s.archive}\n`);
  });

  it("falls back to the single binary on Linux without xz", () => {
    const s = setup({ archive: "valid", platform: { os: "Linux", arch: "x86_64" } });
    const result = install(s, { SEVDESK_MCP_VERSION: VERSION }, { excludeTools: ["xz"] });
    expect(result.status).toBe(0);
    const log = readFileSync(s.curlLog, "utf8");
    expect(log).not.toContain(s.archive);
    expect(log).toContain(`/${s.asset}\n`);
    expect(readFileSync(join(s.installDir, "sevdesk-mcp"), "utf8")).toBe(fakeBinary(VERSION));
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

  // A listed archive whose bytes do not match SHA256SUMS is corruption or tampering, not a
  // reason to try the plain binary: nothing is installed.
  it("aborts on a wrong archive checksum and installs nothing", () => {
    const s = setup({ archive: "valid", archiveChecksum: "f".repeat(64) });
    const result = install(s, { SEVDESK_MCP_VERSION: VERSION });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`checksum mismatch for ${s.archive}`);
    expect(result.stderr).toContain("Nothing was installed.");
    expect(readdirSync(s.installDir)).toEqual([]);
  });

  it("aborts when the archive is not a readable tar", () => {
    const s = setup({ archive: Buffer.from("this is not a tar archive") });
    const result = install(s, { SEVDESK_MCP_VERSION: VERSION });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Nothing was installed.");
    expect(readdirSync(s.installDir)).toEqual([]);
  });

  const crafted: [string, TarMember[]][] = [
    ["a symlink", [{ name: "sevdesk-mcp", type: "symlink", linkname: "/etc/passwd", mode: "755" }]],
    [
      "an extra file",
      [
        { name: "sevdesk-mcp", data: "x", mode: "755" },
        { name: "evil.txt", data: "x" },
      ],
    ],
    ["a ../ path", [{ name: "../evil", data: "x" }]],
  ];
  for (const [what, members] of crafted) {
    it(`aborts when the archive holds ${what} and installs nothing`, () => {
      const s = setup({ archive: ustar(members) });
      const result = install(s, { SEVDESK_MCP_VERSION: VERSION });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Nothing was installed.");
      expect(readdirSync(s.installDir)).toEqual([]);
      expect(existsSync(join(s.dir, "evil"))).toBe(false);
      expect(existsSync(join(dirname(s.dir), "evil"))).toBe(false);
    });
  }

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
