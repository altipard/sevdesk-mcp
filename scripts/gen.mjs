// Applies openapi/overlay.yaml to the vendored sevdesk spec and generates
// TypeScript types into src/generated/. Fails if an overlay action matches
// nothing, so upstream spec changes cannot silently disable a correction.
//
// Options (used by tests): --overlay <file> --out <dir>
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import openapiFormat from "openapi-format";
import openapiTS, { astToString } from "openapi-typescript";

const root = new URL("../", import.meta.url);
const { values: args } = parseArgs({
  options: { overlay: { type: "string" }, out: { type: "string" } },
});

const specPath = fileURLToPath(new URL("openapi/sevdesk.openapi.yaml", root));
const overlayPath = args.overlay
  ? resolve(args.overlay)
  : fileURLToPath(new URL("openapi/overlay.yaml", root));
const outDir = args.out ? pathToFileURL(`${resolve(args.out)}/`) : new URL("src/generated/", root);

const spec = await openapiFormat.parseFile(specPath, { bundle: false });
const overlay = await openapiFormat.parseFile(overlayPath, { bundle: false });
// YAML anchors make several actions share one object; copy each action so
// applying one can never modify the value another action inserts.
overlay.actions = (overlay.actions ?? []).map((action) => structuredClone(action));

const { data: patched, resultData } = await openapiFormat.openapiOverlay(spec, {
  overlaySet: overlay,
});

if (resultData.totalUnusedActions > 0) {
  for (const action of resultData.unusedActions) {
    console.error(`overlay action matched nothing: ${action.description ?? action.target}`);
  }
  process.exit(1);
}

const types = astToString(await openapiTS(patched, { silent: true }));

await mkdir(outDir, { recursive: true });
await writeFile(new URL("sevdesk.openapi.json", outDir), `${JSON.stringify(patched, null, 2)}\n`);
await writeFile(new URL("sevdesk.d.ts", outDir), types);

console.error(
  `gen: applied ${resultData.totalUsedActions}/${resultData.totalActions} overlay actions, wrote ${fileURLToPath(new URL("sevdesk.d.ts", outDir))}`,
);
