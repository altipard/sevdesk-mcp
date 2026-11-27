# Development

[Back to the README](../README.md)

## Status

Early release. Read tools, write tools, the policy layer, the fallback and the HTTP
transport are covered by unit and protocol tests against a mocked sevdesk API; a manual,
read-only smoke test can run the read tools against a real sevdesk test account. Not
every write tool has been verified live yet, see the note in [Tools](tools.md#write-tools).
Issues and feedback are welcome.

## Build and test

```sh
npm ci
npm run gen         # apply the spec overlay and generate API types
npm run check       # gen, lint, typecheck, build, tests
npm run build:bin   # standalone binary for this machine in out/bin/ (needs bun)
npm run smoke:bin   # start that binary and check initialize and tools/list, offline
npm run build:mcpb  # Claude Desktop extension in out/mcpb/sevdesk-mcp.mcpb
npm run smoke:mcpb  # check that extension
```

Node.js 24 (see `.nvmrc`) is all `npm run check` needs; `build:bin` compiles with
[bun](https://bun.sh) and `build:bin:all` builds every release target. CI runs
`npm run check`, checks the installer under a strict POSIX shell, builds and smoke-tests
the binary, and builds and checks the Claude Desktop extension.

## Repository layout for clients

- [`mcpb/`](../mcpb) holds the Claude Desktop extension's `manifest.json` and icon.
  `build:mcpb` builds `dist/` first, then packs `dist/`, `package.json`, the production
  dependencies from `package-lock.json`, the manifest and the icon into
  `out/mcpb/sevdesk-mcp.mcpb`. The extension is a server of type `node` and runs on Claude
  Desktop's built-in Node.js. Its version comes from `package.json`, which the release job
  stamps with the tag version; `mcpb/manifest.json` keeps the placeholder `0.0.0`.
- [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) makes the
  repository a Claude Code plugin marketplace. The plugin lives in
  [`plugins/sevdesk/`](../plugins/sevdesk): its `plugin.json` starts the server with npx
  (no pinned version) and passes the chosen mode, and `skills/sevdesk/` holds the
  `sevdesk` skill with its references.
- [`install.sh`](../install.sh) is the binary installer, a POSIX shell script. After the
  download it hands over to `sevdesk-mcp setup` ([`src/setup/`](../src/setup)), which writes
  the client configurations through add-mcp.
- `src/setup/skill-files.ts` is a generated copy of `plugins/sevdesk/skills/sevdesk`, so the
  binary can install the skill. After changing the skill, regenerate it with
  `UPDATE_SKILL_FILES=1 npx vitest run test/unit/setup-skill.test.ts`; `npm run check` fails
  while the two differ.

## Live smoke test

Calls every read tool once against a real sevdesk account. Use a **test account**, never
production:

```sh
read -rs SEVDESK_LIVE_TEST_TOKEN && export SEVDESK_LIVE_TEST_TOKEN   # paste, Enter
npm run test:live
unset SEVDESK_LIVE_TEST_TOKEN
```

It always runs in `read` mode, aborts if any non-read tool is registered, and prints only
tool name, status and a count, never response content. Without the token it is skipped.
`SEVDESK_LIVE_BASE_URL` overrides the base URL, but only for https hosts on sevdesk.de.
The smoke is not part of `npm run check` or CI.

## Spec overlay

The vendored sevdesk OpenAPI spec
([`openapi/sevdesk.openapi.yaml`](../openapi/sevdesk.openapi.yaml)) has gaps: undeclared
pagination and embed parameters, missing error responses, incomplete status enums. Instead
of editing it, [`openapi/overlay.yaml`](../openapi/overlay.yaml) holds the corrections as
an [OpenAPI Overlay](https://spec.openapis.org/overlay/latest.html). `npm run gen` applies
it and generates the TypeScript types the client is built on. It fails if an overlay action
matches nothing, so an upstream spec change cannot silently drop a correction.

## Releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org). Every push to
`main` runs the release workflow: commitizen derives the next version from the commits
since the last tag (`fix` → patch, `feat` → minor, breaking change → major; other types
release nothing). The version lives only in the tag, without a `v` prefix (for example
`0.2.0`), and is stamped into the build.

A release publishes on GitHub the four binaries (`darwin-arm64`, `darwin-x64`,
`linux-x64`, `linux-arm64`), the Claude Desktop extension `sevdesk-mcp.mcpb` and
`SHA256SUMS` over all of them, plus the npm package with provenance and, after it, the
entry in the official MCP registry (`server.json`, version stamped from the tag). The
binaries and the extension carry a build provenance attestation (`gh attestation verify
<file> --repo altipard/sevdesk-mcp`). Everything is built and attested before anything is
published.
A published asset is never replaced, so re-running a partly failed release completes it
instead of bumping the version again.

## License

MIT, see [`LICENSE`](../LICENSE). Copyright (c) 2026 Zilicon IT Services.

"sevdesk" is a trademark of sevdesk GmbH and is used here only to name the API this server
talks to. This project is not affiliated with, endorsed by or supported by sevdesk GmbH.
