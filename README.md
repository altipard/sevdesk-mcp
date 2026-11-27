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
  - [Claude Code](#claude-code) · [Claude Desktop](#claude-desktop) ·
    [Cursor, VS Code and others](#cursor-vs-code-and-others) ·
    [Binary installer](#binary-installer) · [Token](#token) ·
    [Troubleshooting](#troubleshooting)
- [Connect your MCP client](#connect-your-mcp-client)
- [What it can do](#what-it-can-do)
- [Security model](#security-model)
- [Remote (HTTP)](#remote-http)
- [Configuration](#configuration)
- [Status](#status)
- [Development](#development)
- [License](#license)

## Install

You need a sevdesk API token (32 hex characters; sevdesk issues one per administrator).
Pick your client; the first way listed is the simplest.

| Client | Simplest way | Needs |
| --- | --- | --- |
| [Claude Code](#claude-code) | plugin | Node.js 24+, token in the keychain |
| [Claude Desktop](#claude-desktop) | `sevdesk-mcp.mcpb` extension, double-click | token typed into the extension; runs on Claude Desktop's built-in Node.js |
| [Cursor, VS Code, others](#cursor-vs-code-and-others) | npx entry in the client config | Node.js 24+, token in the keychain |
| any, without Node.js | [binary installer](#binary-installer) | macOS or Linux (glibc) |

### Claude Code

Store the [token](#token) in the keychain first. Then, from your shell (Claude Code v2.1.292
or later), one command adds the marketplace and installs the plugin:

```sh
claude plugin install sevdesk --marketplace altipard/sevdesk-mcp
```

In a Claude Code session (v2.1.275 or later) the same works as
`/plugin install sevdesk --marketplace altipard/sevdesk-mcp`; Claude Code asks you to
confirm the marketplace and opens the plugin's details, where you pick the installation
scope. On older versions add the marketplace first, then install:

```text
/plugin marketplace add altipard/sevdesk-mcp
/plugin install sevdesk@sevdesk-mcp
```

The plugin needs Claude Code v2.1.271 or later, because it lets you pick the mode (`read`,
`write` or `full`, default `read`) when you enable it; change it later under `/plugin` >
Installed > Configure options. It starts the server with npx and reads the token from the
[keychain](#token). It also brings the `sevdesk` skill, which guides the assistant through
invoices, vouchers, contacts and open items and through the preview and confirmation of
changes. Without the plugin, register the server with `claude mcp add` (see
[Connect your MCP client](#connect-your-mcp-client)).

Use one way, not both: the plugin and a `claude mcp add` entry (also written by the
[binary installer](#binary-installer)) would run two sevdesk servers side by side. Remove
the entry with `claude mcp remove --scope user sevdesk`, or the plugin with
`claude plugin uninstall sevdesk@sevdesk-mcp`.

### Claude Desktop

Download `sevdesk-mcp.mcpb` from the
[latest release](https://github.com/altipard/sevdesk-mcp/releases/latest), double-click it
and enter your token in the dialog Claude Desktop shows. The extension keeps the token in
its own settings, not in the keychain entry below. It offers the modes `read` (default) and
`write`; `full` is only available through a [manual configuration](#connect-your-mcp-client).

To check the download before opening it:

```sh
base=https://github.com/altipard/sevdesk-mcp/releases/latest/download
curl -fsSLO "$base/sevdesk-mcp.mcpb"
curl -fsSLO "$base/SHA256SUMS"
grep ' sevdesk-mcp.mcpb$' SHA256SUMS | shasum -a 256 -c -   # Linux: sha256sum -c -
gh attestation verify sevdesk-mcp.mcpb --repo altipard/sevdesk-mcp
```

### Cursor, VS Code and others

Store the [token](#token) in the keychain, then add the server with npx (Node.js 24 or
newer). Cursor (`~/.cursor/mcp.json`) and most other clients:

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "@altipard/sevdesk-mcp"],
      "env": { "SEVDESK_MODE": "read" }
    }
  }
}
```

VS Code:

```sh
code --add-mcp '{"name":"sevdesk","type":"stdio","command":"npx","args":["-y","@altipard/sevdesk-mcp"],"env":{"SEVDESK_MODE":"read"}}'
```

GUI clients often start without your shell's `PATH`; if the server does not start, give
the full path to `npx` (`which npx`) or use the binary installer. More clients and token
options: [Connect your MCP client](#connect-your-mcp-client).

### Binary installer

For macOS and Linux with glibc (x64 and arm64), no Node.js needed:

```sh
curl -fsSL https://raw.githubusercontent.com/altipard/sevdesk-mcp/main/install.sh | sh
```

It downloads the release binary for your platform, verifies it against the release's
`SHA256SUMS` (nothing is installed on a mismatch) and installs it to `~/.local/bin`. In a
terminal it then finds the installed clients (Claude Desktop, Claude Code, Cursor, VS Code
CLI), shows a plan and asks once:

```text
  Setup plan
    token:   ask for it once and store it in the macOS keychain
    mode:    read (--mode=write or SEVDESK_MODE=write to allow changes)
    clients: Claude Desktop, Claude Code
             an existing "sevdesk" entry is updated (command and SEVDESK_MODE set,
             args removed, other env kept); files are backed up first

  Go ahead? [Y/n]
```

The token is read once with hidden input, checked for the 32-hex format and against the
sevdesk API (a rejected token is asked for again), and goes to the keychain, never into a
client configuration. A token already in the keychain is kept. A Claude Code entry with its
own command or env stays unchanged unless you pass `--replace-entries`: carrying its env over
would put the values on a command line, and they are never printed. Remote (URL) entries are
never changed. Changing JSON configurations
needs `jq` or `python3`; files that are not valid JSON are left alone and the installer
prints the entry to add by hand. Without a terminal, or with `--no-setup`, it installs only
and prints the next steps.

<details>
<summary>installer options, manual download, from source</summary>

<br>

**Options**, passed after `sh -s --`:

| Option | Meaning |
| --- | --- |
| `--dry-run` | Show platform, release and target without downloading or changing anything. |
| `--no-setup` | Install only, skip the keychain and MCP client setup. |
| `--mode=MODE` | Mode for the client entries: `read` (default), `write` or `full`. |
| `--replace-token` | Ask for a new token even if one is already in the keychain. |
| `--replace-entries` | Replace a Claude Code entry that has its own command or env (its env is not kept; `~/.claude.json` is copied first, mode 600). |
| `--no-verify` | Store the token without checking it against the sevdesk API. |
| `-h`, `--help` | Show the help. |

**Environment variables**, set for `sh`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `INSTALL_DIR` | `~/.local/bin` | Target directory, absolute path, created if missing, must be writable. |
| `SEVDESK_MCP_VERSION` | `latest` | Release to install, for example `0.2.0` (tags have no `v` prefix). |
| `SEVDESK_MODE` | `read` | Same as `--mode`; the option wins. |
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

### Token

Store the token once in the system keychain: service `sevdesk-mcp`, account `api-token`.
The plugin, npx and the binary read it from there at start when `SEVDESK_API_TOKEN` is
unset, so no configuration file holds it. Never put the token into a project file that
goes into a repository. The binary installer stores it for you; by hand:

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
the client's `env` block. The Claude Desktop extension asks for the token itself.

### Troubleshooting

- **No sevdesk tools, or the server does not start:** no token (neither in the keychain
  nor in `SEVDESK_API_TOKEN`), or Node.js older than 24 for npx and the plugin
  (`node --version`). The client's MCP log shows the reason.
- **HTTP 401 from sevdesk:** the token is wrong. Store it again with the command above
  (`-U` replaces the entry) or run the installer with `--replace-token`.
- **The installer cannot check the token** (offline, proxy): it stores it anyway; pass
  `--no-verify` to skip the check.
- **`full` shows no irreversible tools:** they are off by default and also need
  `SEVDESK_ENABLE_TOOLS`, see [Security model](#security-model).

## Connect your MCP client

All clients below start the server as a local process over stdio; to run it as a shared
service instead, see [Remote (HTTP)](#remote-http). The
[binary installer](#binary-installer) writes these entries for you, and the plugin and the
Desktop extension need none; the snippets below are for doing it by hand, including `full`
mode and other settings. Replace
`/Users/you/.local/bin/sevdesk-mcp` with the absolute path of your binary (`echo
~/.local/bin/sevdesk-mcp`).

> [!WARNING]
> Never put the API token into a project or workspace file that goes into a repository
> (`.cursor/mcp.json`, `.vscode/mcp.json`, `.mcp.json`). Prefer the keychain. Without one,
> use user-level configuration only: in Cursor reference an environment variable with
> `${env:SEVDESK_API_TOKEN}`, in VS Code let it prompt with `${input:…}` (below).

**npx instead of the binary.** Set `"command": "npx"` and
`"args": ["-y", "@altipard/sevdesk-mcp"]`, as in
[Cursor, VS Code and others](#cursor-vs-code-and-others).

**Windows** (untested) has no release binary and no keychain lookup: use npx through
`cmd`, for example `"command": "cmd", "args": ["/c", "npx", "-y", "@altipard/sevdesk-mcp"]`,
and supply the token as above. Claude Desktop has no token reference, so on Windows the
token sits in plain text in its user configuration file. Cursor's `${env:…}` can stay empty
when Cursor is started from the GUI rather than a shell that has the variable. Claude
Desktop reads `%APPDATA%\Claude\claude_desktop_config.json`,
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

Each tool wraps one or a few sevdesk API calls and returns a short text plus compact
structured JSON. `get_document_pdf` and `get_report` return the file as an embedded
resource. Which tools are registered depends on the mode (see
[Security model](#security-model)): `read` offers only the read tools.

**Read tools** (available in every mode):

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

**Write tools.** Class `W` runs directly from `SEVDESK_MODE=write` on. Class `W+` also
needs `write` and runs in two steps with a confirmation token. Class `X` needs `full`, is
off until the operator lists it in `SEVDESK_ENABLE_TOOLS`, and needs a confirmation token
plus approval by a human (elicitation) or, on clients without elicitation, the operator
release that this listing stands for. There is no delete tool.

| Tool | Class | What it does |
| --- | --- | --- |
| `create_contact` | W | Creates an organisation or person, by default as customer with the next free customer number, optionally with invoice address, e-mail and phone. |
| `update_contact` | W | Changes master data of a contact and, where unambiguous, its address, e-mail or phone; with several entries it fails and lists their IDs. |
| `create_invoice_draft` | W | Creates an invoice draft (RE) with free-text or article positions; tax rule and rates are checked first. No invoice number, not sent. |
| `create_order_draft` | W | Creates an estimate (AN) or order confirmation (AB) as draft, with the same checks. Not sent. |
| `create_invoice_from_order` | W | Turns an estimate or order confirmation into an invoice draft: whole (RE), partial (TR) or advance (AR). |
| `create_voucher` | W | Creates a voucher (Beleg) as draft, optionally with the receipt file attached; accounts, tax rule and rates are checked first. |
| `tag_document` | W | Sets a tag by name on an invoice, voucher, order or credit note; sevdesk creates the tag if it does not exist. |
| `mark_invoice_sent` | W+ | Marks an invoice as sent (printed, by post, by e-mail outside sevdesk, downloaded) without sending anything; a draft gets its invoice number. |
| `book_invoice_payment` | W+ | Books a payment on an open or partially paid invoice to a payment account, with an explicit payment type (full, partial, Skonto, bank charges, other, reminder fees). |
| `book_voucher_payment` | W+ | Books a payment on an unpaid or partially paid voucher, with the same payment types. |
| `reset_document_status` | W+ | Resets an invoice, credit note or voucher to draft or to open; linked payments are unlinked. Enshrined documents are refused. |
| `send_invoice_email` | X | Sends an invoice to the customer by e-mail through sevdesk, with explicit recipient, subject and text. |
| `cancel_invoice` | X | Cancels an invoice by creating a numbered cancellation invoice (Stornorechnung). |
| `enshrine_document` | X | Enshrines (festschreiben) an invoice, credit note or voucher; afterwards it can never be changed, reset or deleted (GoBD). |

`create_voucher` attaches a receipt as PDF, PNG or JPEG up to 10 MiB, passed as base64.
The draft tools create a new object on every call, and the payment tools book again on
every confirmed call.

> [!CAUTION]
> **Try write tools on test data first.** They are tested against the sevdesk OpenAPI spec
> and a mocked API, but the spec is incomplete and some request shapes can only be
> verified against a live account. Start with a test contact and a test draft, check the
> result in sevdesk, and only then use them on real bookkeeping data.

`sevdesk_api_request` only accepts operations on its allowlist. By default that is a
curated list of side-effect-free reads; `SEVDESK_API_ALLOW` replaces it. Every listed
operation still has to fit the mode and goes through the same confirmation rules as the
tools.

> [!NOTE]
> Everything a tool reads (customer names, IBANs, amounts, PDFs) goes to your MCP client
> and from there to the client's model provider.

## Security model

An accounting system is not a place for an assistant to improvise, so the defaults are
strict and every relaxation is an explicit setting.

- **Mode.** `SEVDESK_MODE` sets the ceiling: `read` (default) allows only reads, `write`
  adds drafts, master data and status changes, `full` adds irreversible actions (sending
  e-mail, cancellation, enshrining). Deleting has no tool; it is only possible through
  `sevdesk_api_request` for delete operations listed in `SEVDESK_API_ALLOW`. Tools above
  the mode are not registered, and no other setting can lift an operation above it.
- **Risk classes.** Every sevdesk operation is classified: `R` plain read, `R+` bulk
  export, `W` correctable change, `W+` status or booking change, `X` irreversible. An
  operation without a class is refused everywhere. Each tool declares the operations it
  uses; a request outside that list or above the tool's class is refused before it leaves
  the server.
- **Tool lists.** `SEVDESK_ALLOWED_TOOLS` narrows the tool set to the names listed,
  `SEVDESK_DENIED_TOOLS` removes tools and always wins, `SEVDESK_ENABLE_TOOLS` switches on
  tools that are off by default (bulk exports and every irreversible tool), still capped by
  the mode. Unknown tool names stop the server at startup.
- **Two-step calls for `W+` and `X`.** `W` changes run directly, within the mode and
  allowlist. For `W+` and `X` the first call only reads: the curated tools return a
  preview with the facts read from sevdesk (number, contact, amount, status before and
  after, warnings) and a confirmation token. `sevdesk_api_request` reads nothing for its
  preview; it shows only the operation, method, path and body. The second call with the
  same arguments and the token executes the action. The token is an HMAC bound to the
  tool, the exact arguments and the caller, is valid exactly once and expires
  (`SEVDESK_CONFIRM_TTL_SECONDS`). Over stdio "exactly once" holds per process: the used
  nonces live in memory, so with a fixed `SEVDESK_CONFIRM_SECRET` a token that one process
  has used is still accepted by a restarted or second process within its lifetime.
- **Human approval for `X`.** On the second call the server asks the user through the
  client (MCP elicitation). For the curated tools the question shows the facts read for
  the preview, for example invoice number, customer, amount and recipient, so the user
  approves what will actually be acted on, not only the arguments. For
  `sevdesk_api_request` it shows only the operation, method and path. For clients that cannot ask, the
  operator's explicit listing in `SEVDESK_ENABLE_TOOLS` (or of the operation in
  `SEVDESK_API_ALLOW`) counts as the release; then no human sees the action before it runs.
- **Once per target.** Each irreversible action runs at most once per target within 24
  hours, for example one e-mail per invoice. Over HTTP the lock lives in Redis and is
  shared by all instances. Over stdio it lives only in the running process: a restart or
  a second client with its own server process starts without it. A definite rejection
  from sevdesk (HTTP 4xx) releases the lock so the action can be retried; an unknown
  outcome (timeout, 5xx, lost connection) keeps it, so check in sevdesk before trying
  again.
- **Audit log.** Every write attempt is logged as a JSON line, whatever `LOG_LEVEL` says:
  who, which tool or operation, which object, and the outcome. Arguments, bodies and
  tokens are never logged; the API token and confirmation secret are redacted from log
  lines, audit entries and error text.
- **Text from sevdesk.** Names, descriptions and payment references are marked as data,
  not instructions, and hidden characters are stripped. A model can still be misled by
  such text, so review what it proposes.

> [!IMPORTANT]
> **What holds against a manipulated model.** A confirmation token proves that a preview
> was fetched for exactly these arguments, not that a human read it: a model following
> injected instructions can make both calls itself. Elicitation only helps where the
> client actually asks a human; on clients that cannot ask, the operator release in
> `SEVDESK_ENABLE_TOOLS` stands in and no human sees the action. The hard limits are the
> mode and, over HTTP, the token's scopes. Give the server no more than the work needs.

## Remote (HTTP)

Besides stdio the server can run as a shared service over the MCP Streamable HTTP
transport, for example for a team or a hosted client. It acts as an OAuth 2.1 resource
server: it does not log anyone in, it only validates access tokens issued by your
authorization server (identity provider).

- **Endpoint.** The MCP endpoint is the path of `MCP_RESOURCE_URL` (for example `/mcp`).
  `/healthz` answers liveness probes without authentication. Protected Resource Metadata
  ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)) is served under
  `/.well-known/oauth-protected-resource/<path>` and names the authorization server and the
  supported scopes, so clients can discover where to get a token.
- **Tokens.** JWT access tokens (`typ: at+jwt`,
  [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068)) signed with an asymmetric algorithm,
  with `iss` equal to `OAUTH_ISSUER`, `aud` equal to `MCP_RESOURCE_URL`, a `sub` and a
  client ID (`client_id` or `azp`). Keys come from `OAUTH_JWKS_URL`.
- **Scopes.** `sevdesk:read`, `sevdesk:write`, `sevdesk:irreversible`. They form a ladder
  without implied steps: each level needs its own scope and every scope below it, so issue
  `sevdesk:write` only together with `sevdesk:read`. A token without `sevdesk:read` gets
  no rights at all. Scopes are read only from the `scope` claim, a space-separated string
  as in RFC 9068; an `scp` array is ignored.
- **Effective rights = min(mode, scopes).** `SEVDESK_MODE` caps the instance, the token's
  scopes cap each caller. A call to a tool above the token's scopes gets HTTP 403
  `insufficient_scope` naming the scopes it needs, so the client can request them.
  Confirmation tokens are bound to the caller (`sub`, else client ID).
- **sevdesk token.** The server uses one sevdesk API token for all callers, taken from
  `SEVDESK_API_TOKEN` only (no keychain lookup). Everyone with a valid access token acts as
  that sevdesk user, within their scopes.
- **Host and Origin.** `MCP_ALLOWED_HOSTS` is the allowlist for the `Host` header (DNS
  rebinding protection) and for the `Origin` header of the MCP endpoint; it defaults to the
  host of `MCP_RESOURCE_URL`. Requests without `Origin` (CLI and desktop clients,
  server-side SDKs) are not affected. A request whose `Origin` names another host, or that
  sends `Origin: null`, gets HTTP 403. Add the host of a browser-based client to let it in.
  The `Host` check covers every path except `/healthz`, including the metadata under
  `/.well-known`; only the `Origin` check is limited to the MCP endpoint.
- **Logs** go to stdout as JSON lines, audit events included.

### Run it

The image built from [`Dockerfile`](Dockerfile) runs the HTTP server and holds no
secrets; configuration comes from the environment at run time.
[`compose.yaml`](compose.yaml) runs it locally with a Redis set up as described below,
ports bound to localhost only:

```sh
# Redis in a container, server from source (variables from .env.example in your shell)
docker compose up -d redis
npm run build && npm run start:http

# or everything in containers
docker compose --profile app up --build
```

`OAUTH_ISSUER` and `OAUTH_JWKS_URL` have no default and must be set, also for compose,
along with `SEVDESK_API_TOKEN` and `SEVDESK_CONFIRM_SECRET`. Missing or invalid variables
stop the server at startup with a configuration error that names them. The HTTP server reads the [common variables](#configuration) plus
[its own](#http-transport-only).

### Redis

Redis holds the single-use confirmation nonces and the once-per-target locks of
irreversible actions. If it forgets them, a used confirmation can become valid again.
Run it like this:

- **Persistence via AOF:** `appendonly yes` with `appendfsync always`, or accept that a
  crash can forget the last second of writes with `everysec`.
- **`maxmemory-policy noeviction`,** so nonces are never evicted. Under memory pressure
  Redis then refuses writes and the server fails closed.
- **A Redis of its own,** not a shared cache that others flush or evict.

At startup the server warns if `maxmemory-policy` is not `noeviction` (on managed Redis
without `CONFIG GET` it only logs that it could not check). It also writes a sentinel key;
if that disappears or changes while the server runs, confirmations (`W+` and `X`) are
refused until a restart.

The sentinel has limits. It only detects a total loss (`FLUSHALL`, Redis restarted empty)
while the server is running. It does not detect a partial loss (single keys evicted or
lost in the last fsync window), and it does not detect a loss that happened while the
server was down: a restart simply writes a new sentinel. Persistence and `noeviction` are
the actual protection.

**Recovery after "redis lost its data":** fix persistence, wait at least
`SEVDESK_CONFIRM_TTL_SECONDS` + 60 seconds so every confirmation token issued before the
loss has expired, then restart. Check in sevdesk the irreversible actions (e-mails,
cancellations, enshrining, and deletes released via `SEVDESK_API_ALLOW`) of the last 24
hours: their once-per-target lock was lost as well.

### Shutdown

On `SIGTERM` the server stops accepting MCP requests (they get HTTP 503, `/healthz`
reports draining), waits up to 10 seconds for in-flight requests and exits at the latest
after about 15 seconds. Give it more time than that before `SIGKILL`:
`stop_grace_period: 20s` in compose (already set) and `terminationGracePeriodSeconds` of
at least 20 on Kubernetes.

## Configuration

All configuration comes from environment variables; see [`.env.example`](.env.example).
Empty values count as unset. The first table applies to both transports, the second only
to the [HTTP transport](#remote-http).

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEVDESK_API_TOKEN` | keychain | sevdesk API token. Unset: read from the keychain (service `sevdesk-mcp`, account `api-token`); required if there is none. HTTP: environment only. |
| `SEVDESK_MODE` | `read` | `read`, `write` or `full`. |
| `SEVDESK_ALLOWED_TOOLS` | all tools | Comma-separated whitelist of tool names. Only narrows; never switches on a tool that is off by default. |
| `SEVDESK_DENIED_TOOLS` | none | Comma-separated tool names that are never registered. Always wins. |
| `SEVDESK_ENABLE_TOOLS` | none | Comma-separated tools that are off by default to switch on (every `X` tool, bulk exports), still capped by the mode. For `X` it counts as the release for clients without elicitation. |
| `SEVDESK_API_ALLOW` | curated reads | Comma-separated `operationId`s for `sevdesk_api_request`. Unknown or unclassified IDs stop the server at startup. |
| `SEVDESK_CONFIRM_SECRET` | random per process | HMAC key for confirmation tokens, at least 32 characters. Required for HTTP. |
| `SEVDESK_CONFIRM_TTL_SECONDS` | `300` | Lifetime of a confirmation token, 30 to 3600 seconds. |
| `SEVDESK_BASE_URL` | `https://my.sevdesk.de/api/v1` | API base URL. https only, http only for localhost. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. JSON lines on stderr (stdio) or stdout (HTTP); audit events are written at every level. |
| `SEVDESK_LIVE_TEST_TOKEN` | unset | Live smoke only: token of a sevdesk test account; unset skips the smoke. |
| `SEVDESK_LIVE_BASE_URL` | `SEVDESK_BASE_URL` default | Live smoke only: https on sevdesk.de or a subdomain. |

### HTTP transport only

Not read by the stdio server. The HTTP server also needs `SEVDESK_API_TOKEN` (from the
environment, no keychain) and `SEVDESK_CONFIRM_SECRET`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to bind. |
| `MCP_RESOURCE_URL` | required | Public URL of the MCP endpoint as clients reach it, and the audience (`aud`) tokens must carry. https; http only for localhost. No query; the path must not be `/healthz` or under `/.well-known/`. |
| `MCP_ALLOWED_HOSTS` | host of `MCP_RESOURCE_URL` | Comma-separated host names allowed in `Host` and `Origin`, for example behind a reverse proxy. |
| `OAUTH_ISSUER` | required | Expected `iss` claim, compared as an exact string. https. |
| `OAUTH_JWKS_URL` | required | Public keys of the authorization server. https. |
| `OAUTH_ALGORITHMS` | `RS256` | Comma-separated JWS algorithms, asymmetric only (RS, PS, ES and EdDSA families). |
| `OAUTH_ALLOW_INSECURE_HTTP` | `false` | `true` accepts plain http for `OAUTH_ISSUER` and `OAUTH_JWKS_URL`. Local development only. |
| `REDIS_URL` | required | `redis://` or `rediss://` URL of the store for confirmation nonces and once-per-target locks. Can carry a password; treat it as a secret. |

## Status

Early release. Read tools, write tools, the policy layer, the fallback and the HTTP
transport are covered by unit and protocol tests against a mocked sevdesk API; a manual,
read-only smoke test can run the read tools against a real sevdesk test account. Not
every write tool has been verified live yet, see the note under
[What it can do](#what-it-can-do). Issues and feedback are welcome.

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
unset SEVDESK_LIVE_TEST_TOKEN
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
