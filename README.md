<p align="center">
  <img src="assets/logo/sevdesk-mcp.svg" alt="sevdesk-mcp logo: an owl bookkeeper with spectacles" width="160">
</p>

<h1 align="center">sevdesk-mcp</h1>

<p align="center">
  <b>A sevdesk MCP server: ask your AI assistant about invoices, contacts, vouchers and bank transactions in sevdesk.</b><br>
  Unofficial. Curated tools, read-only by default; status changes, bookings and irreversible actions need confirmation.
</p>

<p align="center">
  <a href="https://github.com/altipard/sevdesk-mcp/actions/workflows/ci.yml"><img src="https://github.com/altipard/sevdesk-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@altipard/sevdesk-mcp"><img src="https://img.shields.io/npm/v/@altipard/sevdesk-mcp" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white" alt="Node.js 24 or newer">
</p>

<!-- Demo GIF goes here once a recording exists. -->

sevdesk-mcp is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server
for the [sevdesk](https://sevdesk.de) accounting API. It connects sevdesk to AI assistants
and MCP clients such as Claude Desktop, Claude Code, Cursor and VS Code, so you can ask
questions like "which invoices are overdue?" or "did the payment from ACME arrive?" in
plain language. Instead of exposing the whole API it offers a small set of curated tools
with compact answers, plus a guarded fallback for everything else.

> [!IMPORTANT]
> **Unofficial.** This project is not affiliated with, endorsed by or supported by
> sevdesk GmbH. "sevdesk" is a trademark of sevdesk GmbH and is used here only to
> name the API this server talks to.

## Contents

- [Install](#install)
- [Connect your MCP client](#connect-your-mcp-client)
- [What it can do](#what-it-can-do)
- [Security model](#security-model)
- [Configuration](#configuration)
- [Status](#status)
- [Development](#development)
- [License](#license)

## Install

You need a sevdesk API token (32 hex characters; sevdesk issues one per administrator).
Pick one of the following.

**Installer** (macOS and Linux with glibc, x64 and arm64):

```sh
curl -fsSL https://raw.githubusercontent.com/altipard/sevdesk-mcp/main/install.sh | sh
```

It downloads the release binary for your platform, verifies it against the release's
`SHA256SUMS` (nothing is installed on a mismatch) and installs it to `~/.local/bin`. In a
terminal it then offers a guided setup, asking before every step:

1. store the API token in the system keychain,
2. pick the mode for the client entries (`read`, `write` or `full`, default `read`),
3. register the server with Claude Desktop, Claude Code, Cursor and VS Code.

The token never goes into a client configuration file. Existing client configs are backed
up before they are changed and are left alone if they are not valid JSON; changing them
needs `jq` or `python3`, otherwise the installer prints the snippet to add by hand.
Without a terminal it installs only and prints the next steps.

**npx** (any platform with Node.js 24 or newer), nothing to install up front:

```sh
npx -y @altipard/sevdesk-mcp
```

<details>
<summary>installer options, manual download, from source</summary>

<br>

**Options**, passed after `sh -s --`:

| Option | Meaning |
| --- | --- |
| `--dry-run` | Show platform, release and target without downloading or changing anything. |
| `--no-setup` | Install only, skip the keychain and MCP client setup. |
| `-h`, `--help` | Show the help. |

**Environment variables**, set for `sh`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `INSTALL_DIR` | `~/.local/bin` | Target directory, absolute path, created if missing, must be writable. |
| `SEVDESK_MCP_VERSION` | `latest` | Release to install, for example `0.2.0` (tags have no `v` prefix). |
| `NO_COLOR` | | Set to any value to disable colored output. |

```sh
curl -fsSL https://raw.githubusercontent.com/altipard/sevdesk-mcp/main/install.sh \
  | INSTALL_DIR="$HOME/bin" SEVDESK_MCP_VERSION=0.2.0 sh -s -- --no-setup
```

The installer needs `curl` and `sha256sum` or `shasum`. Release binaries exist for
`darwin-arm64`, `darwin-x64`, `linux-x64` and `linux-arm64`; under Rosetta it picks the
native arm64 binary. The Linux binaries are built against glibc, so on musl systems such as
Alpine use npx instead.

**Manual download.** Every release carries `sevdesk-mcp-<os>-<arch>` plus `SHA256SUMS`:

```sh
base=https://github.com/altipard/sevdesk-mcp/releases/latest/download
asset=sevdesk-mcp-linux-x64
curl -fsSLO "$base/$asset"
curl -fsSLO "$base/SHA256SUMS"
grep " $asset\$" SHA256SUMS | sha256sum -c -   # macOS: shasum -a 256 -c -
mkdir -p ~/.local/bin
install -m 755 "$asset" ~/.local/bin/sevdesk-mcp
```

**From source** (Node.js 24 or newer):

```sh
git clone https://github.com/altipard/sevdesk-mcp.git
cd sevdesk-mcp
npm ci
npm run build
node dist/bin/stdio.js
```

</details>

### Keep the token in the keychain

If `SEVDESK_API_TOKEN` is unset, the server reads the token from the system keychain at
start: service `sevdesk-mcp`, account `api-token`. That way no client configuration holds
the token. The installer's setup stores it there; to do it by hand:

macOS (prompts for the token, so it does not land in your shell history):

```sh
security add-generic-password -U -s sevdesk-mcp -a api-token -w
```

Linux with a Secret Service keyring (GNOME Keyring, KWallet) and `secret-tool`
(`libsecret-tools` on Debian and Ubuntu):

```sh
secret-tool store --label=sevdesk-mcp service sevdesk-mcp account api-token
```

`SEVDESK_API_TOKEN` always wins over the keychain. On systems without a keychain, set it in
the client's `env` block.

## Connect your MCP client

All clients start the server as a local process over stdio. The installer's setup writes
these entries for you; the snippets below are for doing it by hand. Replace
`/Users/you/.local/bin/sevdesk-mcp` with the absolute path of your binary (`echo
~/.local/bin/sevdesk-mcp`).

> [!WARNING]
> Never put the API token into a project or workspace file that goes into a repository
> (`.cursor/mcp.json`, `.vscode/mcp.json`, `.mcp.json`). Prefer the keychain. Without one,
> use user-level configuration only: in Cursor reference an environment variable with
> `${env:SEVDESK_API_TOKEN}`, in VS Code let it prompt with `${input:…}` (below).

**npx instead of the binary.** Set `"command": "npx"` and
`"args": ["-y", "@altipard/sevdesk-mcp"]`. GUI clients often start without your shell's
`PATH`, so give the full path to `npx` (`which npx`) or, better, use the binary.

**Windows** has no release binary and no keychain lookup: use npx through `cmd`, for
example `"command": "cmd", "args": ["/c", "npx", "-y", "@altipard/sevdesk-mcp"]`, and
supply the token as above. Claude Desktop reads `%APPDATA%\Claude\claude_desktop_config.json`,
the VS Code user configuration lives in `%APPDATA%\Code\User\mcp.json`, and Cursor uses
`%USERPROFILE%\.cursor\mcp.json`.

<details>
<summary>Claude Desktop</summary>

<br>

Settings > Developer > Edit Config opens `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "/Users/you/.local/bin/sevdesk-mcp",
      "env": { "SEVDESK_MODE": "read" }
    }
  }
}
```

Restart Claude Desktop afterwards.

</details>

<details>
<summary>Claude Code</summary>

<br>

```sh
claude mcp add --scope user sevdesk --env SEVDESK_MODE=read -- ~/.local/bin/sevdesk-mcp
```

Leave out `--scope user` to register it for the current project only.

</details>

<details>
<summary>Cursor</summary>

<br>

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project, never with a
token):

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "/Users/you/.local/bin/sevdesk-mcp",
      "env": { "SEVDESK_MODE": "read" }
    }
  }
}
```

Without a keychain, in `~/.cursor/mcp.json` only, pass the token from your environment:
`"env": { "SEVDESK_MODE": "read", "SEVDESK_API_TOKEN": "${env:SEVDESK_API_TOKEN}" }`.

</details>

<details>
<summary>VS Code</summary>

<br>

```sh
code --add-mcp '{"name":"sevdesk","type":"stdio","command":"/Users/you/.local/bin/sevdesk-mcp","env":{"SEVDESK_MODE":"read"}}'
```

Or in `.vscode/mcp.json` in a workspace (no token in this file):

```json
{
  "servers": {
    "sevdesk": {
      "type": "stdio",
      "command": "/Users/you/.local/bin/sevdesk-mcp",
      "env": { "SEVDESK_MODE": "read" }
    }
  }
}
```

Without a keychain, VS Code can prompt for the token once and store it securely; the
file then holds only the reference, not the token:

```json
{
  "inputs": [
    { "type": "promptString", "id": "sevdesk-token", "description": "sevdesk API token", "password": true }
  ],
  "servers": {
    "sevdesk": {
      "type": "stdio",
      "command": "/Users/you/.local/bin/sevdesk-mcp",
      "env": { "SEVDESK_MODE": "read", "SEVDESK_API_TOKEN": "${input:sevdesk-token}" }
    }
  }
}
```

</details>

Other settings from [Configuration](#configuration), for example
`SEVDESK_DENIED_TOOLS=get_report`, go into the same `env` block.

> [!TIP]
> Ask the assistant to call `get_account_info` first. It checks the connection and tells
> you which mode the server runs in.

## What it can do

The server currently ships **read-only** tools; there are no curated write tools yet.
Each one wraps one or a few sevdesk API calls and returns a short text plus compact
structured JSON. `get_document_pdf` and `get_report` return the file as an embedded
resource.

| Tool | What it does |
| --- | --- |
| `get_account_info` | Checks the connection, returns the bookkeeping system version and the server's mode. |
| `search_contacts` | Finds contacts by name, customer number or e-mail. Name and e-mail search scan at most 500 contacts or addresses, plus up to 100 organisations from sevdesk's own name filter, and say when they stopped early. |
| `get_contact` | One contact with master data, addresses and communication ways. |
| `search_invoices` | Lists invoices by status, date range, contact or invoice number, with open amounts. |
| `get_invoice` | One invoice with positions, amounts, dates and status. |
| `list_open_receivables` | Open and partially paid invoices with days overdue, totals per currency and type. Recurring-invoice templates (WKR) are left out by default; the answer can be marked incomplete after a timeout or failed page. |
| `get_document_pdf` | The rendered PDF of an invoice, credit note or order, without marking it as sent. |
| `search_orders` | Estimates, order confirmations and delivery notes by status, date, contact or number. |
| `search_vouchers` | Vouchers (incoming invoices, receipts) by status, date, text, debit/credit or supplier. |
| `get_voucher` | One voucher with positions, booking accounts and tax rates. |
| `list_bank_accounts` | Payment accounts (bank, cash, clearing) with balance and IBAN. |
| `search_transactions` | Bank transactions by account, date, reference, payer/payee, booked or open, direction. |
| `search_parts` | Parts (products and services) with prices, tax rate and stock. |
| `get_tax_guidance` | Which booking accounts, tax rules and tax rates sevdesk allows together. |
| `get_report` | sevdesk's rendered list report (usually a PDF) of invoices, orders, contacts or vouchers. |
| `sevdesk_api_request` | Guarded fallback: calls one sevdesk operation without a dedicated tool by `operationId`. |

`sevdesk_api_request` only accepts operations on its allowlist. By default that is a
curated list of side-effect-free reads; `SEVDESK_API_ALLOW` replaces it. Every listed
operation still has to fit the mode and goes through the confirmation rules below.
Today `SEVDESK_MODE=write` or `full` only has an effect on `sevdesk_api_request`, and only
for operations listed in `SEVDESK_API_ALLOW`.

**Planned:** curated write tools (drafts, master data, status changes) and a remote
HTTP transport with OAuth. The policy layer for both is already in place, see
[Security model](#security-model).

> [!NOTE]
> Everything a tool reads (customer names, IBANs, amounts, PDFs) goes to your MCP client
> and from there to the client's model provider.

## Security model

An accounting system is not a place for an assistant to improvise, so the defaults are
strict and every relaxation is an explicit setting.

- **Mode.** `SEVDESK_MODE` sets the ceiling: `read` (default) allows only reads, `write`
  adds drafts, master data and status changes, `full` adds irreversible actions (sending
  e-mail, cancellation, enshrining, deleting). No other setting can lift an operation above
  the mode. With no curated write tools yet, this applies to `sevdesk_api_request`.
- **Risk classes.** Every sevdesk operation is classified: `R` plain read, `R+` bulk
  export, `W` correctable change, `W+` status or booking change, `X` irreversible. An
  operation without a class is refused everywhere.
- **Tool lists.** `SEVDESK_ALLOWED_TOOLS` narrows the tool set to the names listed,
  `SEVDESK_DENIED_TOOLS` removes tools and always wins, `SEVDESK_ENABLE_TOOLS` switches on
  tools that are off by default (bulk exports and every irreversible tool), still capped by
  the mode. Unknown tool names stop the server at startup.
- **Confirmation tokens.** `W` changes run directly, within the mode and allowlist.
  `W+` and `X` actions run in two steps: the first call returns a
  preview and a signed confirmation token bound to exactly that action, the second call
  with the token executes it. Tokens expire (`SEVDESK_CONFIRM_TTL_SECONDS`).
- **Irreversible actions** additionally need a single-use token, run at most once per
  target within 24 hours in the same server process, and require human approval: the client asks the user (MCP elicitation), or, for
  clients that cannot ask, the operator's explicit listing in `SEVDESK_ENABLE_TOOLS` or
  `SEVDESK_API_ALLOW` counts as the release.
- **Audit log.** Every write attempt is logged to stderr as a JSON line, whatever
  `LOG_LEVEL` says: who, which tool or operation, which object, and the outcome. Arguments,
  bodies and tokens are never logged; the API token and confirmation secret are redacted
  from log lines, audit entries and error text.
- **Text from sevdesk.** Names, descriptions and payment references are marked as data,
  not instructions, and hidden characters are stripped. A model can still be misled by
  such text, so review what it proposes.

## Configuration

All configuration comes from environment variables; see [`.env.example`](.env.example).
Empty values count as unset.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEVDESK_API_TOKEN` | keychain | sevdesk API token. Unset: read from the keychain (service `sevdesk-mcp`, account `api-token`); required if there is none. |
| `SEVDESK_MODE` | `read` | `read`, `write` or `full`. |
| `SEVDESK_ALLOWED_TOOLS` | all tools | Comma-separated whitelist of tool names. Only narrows. |
| `SEVDESK_DENIED_TOOLS` | none | Comma-separated tool names that are never registered. |
| `SEVDESK_ENABLE_TOOLS` | none | Comma-separated tools that are off by default to switch on. |
| `SEVDESK_API_ALLOW` | curated reads | Comma-separated `operationId`s for `sevdesk_api_request`. |
| `SEVDESK_CONFIRM_SECRET` | random per process | HMAC key for confirmation tokens, at least 32 characters. |
| `SEVDESK_CONFIRM_TTL_SECONDS` | `300` | Lifetime of a confirmation token, 30 to 3600 seconds. |
| `SEVDESK_BASE_URL` | `https://my.sevdesk.de/api/v1` | API base URL. https only, http only for localhost. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs go to stderr as JSON lines. |
| `SEVDESK_LIVE_TEST_TOKEN` | unset | Live smoke only: token of a sevdesk test account; unset skips the smoke. |
| `SEVDESK_LIVE_BASE_URL` | `SEVDESK_BASE_URL` default | Live smoke only: https on sevdesk.de or a subdomain. |

## Status

Early release. The read tools, the policy layer and the fallback are covered by unit and
protocol tests against a mocked sevdesk API; a manual, read-only smoke test can run them
against a real sevdesk test account. Write tools and the HTTP transport are next. Issues and
feedback are welcome.

## Development

```sh
npm ci
npm run gen     # apply the spec overlay and generate API types
npm run check   # gen, lint, typecheck, build, tests
npm run build:bin   # standalone binary for this machine in out/bin/ (needs bun)
npm run smoke:bin   # start that binary and check initialize and tools/list, offline
```

Node.js 24 (see `.nvmrc`) is all `npm run check` needs; `build:bin` compiles with
[bun](https://bun.sh) and `build:bin:all` builds every release target. CI runs
`npm run check`, checks the installer under a strict POSIX shell and builds and smoke-tests
the binary.

<details>
<summary>live smoke test, spec overlay</summary>

<br>

**Live smoke test.** Calls every read tool once against a real sevdesk account. Use a
**test account**, never production:

```sh
read -rs SEVDESK_LIVE_TEST_TOKEN && export SEVDESK_LIVE_TEST_TOKEN   # paste, Enter
npm run test:live
```

It always runs in `read` mode, aborts if any non-read tool is registered, and prints only
tool name, status and a count, never response content. Without the token it is skipped.
`SEVDESK_LIVE_BASE_URL` overrides the base URL, but only for https hosts on sevdesk.de.
The smoke is not part of `npm run check` or CI.

**Spec overlay.** The vendored sevdesk OpenAPI spec
([`openapi/sevdesk.openapi.yaml`](openapi/sevdesk.openapi.yaml)) has gaps: undeclared
pagination and embed parameters, missing error responses, incomplete status enums. Instead of editing it,
[`openapi/overlay.yaml`](openapi/overlay.yaml) holds the corrections as an
[OpenAPI Overlay](https://spec.openapis.org/overlay/latest.html). `npm run gen` applies it
and generates the TypeScript types the client is built on. It fails if an overlay action
matches nothing, so an upstream spec change cannot silently drop a correction.

</details>

**Releases.** Commits follow [Conventional Commits](https://www.conventionalcommits.org).
Every push to `main` runs the release workflow: commitizen derives the next version from
the commits since the last tag (`fix` → patch, `feat` → minor, breaking change → major;
other types release nothing). The version lives only in the tag, without a `v` prefix
(for example `0.2.0`), and is stamped into the build. A release publishes the four binaries
with `SHA256SUMS` on GitHub and the npm package with provenance.

## License

MIT, see [`LICENSE`](LICENSE). Copyright (c) 2026 Zilicon IT Services.

sevdesk is a trademark of sevdesk GmbH. This project is not affiliated with or endorsed by
sevdesk GmbH.
