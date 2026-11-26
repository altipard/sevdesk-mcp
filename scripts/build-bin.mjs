// Compiles src/bin/stdio.ts into standalone executables with bun.
//
//   bun scripts/build-bin.mjs                 host platform only
//   bun scripts/build-bin.mjs --all           every release target
//   bun scripts/build-bin.mjs linux-x64 ...   selected targets
//
// Output: out/bin/sevdesk-mcp-<os>-<arch>, the release asset names.
//
// src/version.ts reads package.json next to the module at runtime. A compiled
// binary has no package.json beside it, so the build replaces that one read
// with the file's content. The build fails if the expression is not found, so
// a change in version.ts cannot ship a binary that crashes on start.
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (typeof Bun === "undefined") {
  console.error("build-bin: run with bun (bun scripts/build-bin.mjs)");
  process.exit(1);
}

const root = new URL("../", import.meta.url);
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const PACKAGE_READ = 'readFileSync(new URL("../package.json", import.meta.url), "utf8")';

function hostTarget() {
  const os = { darwin: "darwin", linux: "linux" }[process.platform];
  const arch = { arm64: "arm64", x64: "x64" }[process.arch];
  const target = os && arch ? `${os}-${arch}` : undefined;
  if (!target || !TARGETS.includes(target)) {
    console.error(`build-bin: no release target for ${process.platform}-${process.arch}`);
    process.exit(1);
  }
  return target;
}

const args = process.argv.slice(2);
const targets = args.includes("--all") ? TARGETS : args.length > 0 ? args : [hostTarget()];
for (const target of targets) {
  if (!TARGETS.includes(target)) {
    console.error(`build-bin: unknown target ${target} (known: ${TARGETS.join(", ")})`);
    process.exit(1);
  }
}

const packageJson = readFileSync(new URL("package.json", root), "utf8");
const { version } = JSON.parse(packageJson);

const embedPackageJson = {
  name: "embed-package-json",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]version\.ts$/ }, async (loaded) => {
      const source = readFileSync(loaded.path, "utf8");
      if (!source.includes(PACKAGE_READ)) {
        throw new Error(`build-bin: ${loaded.path} no longer contains ${PACKAGE_READ}`);
      }
      return { contents: source.replace(PACKAGE_READ, JSON.stringify(packageJson)), loader: "ts" };
    });
  },
};

const outDir = new URL("out/bin/", root);
mkdirSync(outDir, { recursive: true });

for (const target of targets) {
  const outfile = fileURLToPath(new URL(`sevdesk-mcp-${target}`, outDir));
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("src/bin/stdio.ts", root))],
    compile: { target: `bun-${target}`, outfile },
    minify: true,
    sourcemap: "none",
    plugins: [embedPackageJson],
    throw: false,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    console.error(`build-bin: ${target} failed`);
    process.exit(1);
  }
  chmodSync(outfile, 0o755);
  console.error(`build-bin: ${version} ${target} -> ${fileURLToPath(outDir)}sevdesk-mcp-${target}`);
}
