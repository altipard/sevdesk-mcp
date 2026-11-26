import { readFileSync } from "node:fs";

// Resolved relative to this module: src/version.ts and dist/version.js both
// sit one level below the package root, so the path works in tests and in
// the published package. Reading package.json keeps the version in sync with
// the commitizen bump without a generated file.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export const SERVER_NAME = "sevdesk-mcp";
export const VERSION: string = pkg.version;
export const USER_AGENT = `${SERVER_NAME}/${VERSION}`;
