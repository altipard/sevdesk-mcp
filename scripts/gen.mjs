// Applies openapi/overlay.yaml to the vendored sevdesk spec and generates
// TypeScript types into src/generated/. Fails if an overlay action matches
// nothing, so upstream spec changes cannot silently disable a correction.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import openapiFormat from "openapi-format";
import openapiTS, { astToString } from "openapi-typescript";

const root = new URL("../", import.meta.url);
const specPath = fileURLToPath(new URL("openapi/sevdesk.openapi.yaml", root));
const overlayPath = fileURLToPath(new URL("openapi/overlay.yaml", root));
const outDir = new URL("src/generated/", root);

const spec = await openapiFormat.parseFile(specPath, { bundle: false });
const overlay = await openapiFormat.parseFile(overlayPath, { bundle: false });

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
  `gen: applied ${resultData.totalUsedActions}/${resultData.totalActions} overlay actions, wrote src/generated/sevdesk.d.ts`,
);
