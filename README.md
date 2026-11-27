<p align="center">
  <img src="assets/logo/sevdesk-mcp.svg" alt="sevdesk-mcp logo: an owl bookkeeper with spectacles" width="160">
</p>

<h1 align="center">sevdesk-mcp</h1>

<p align="center">
  <b>Ask your AI assistant about your sevdesk bookkeeping.</b><br>
  Read-only by default. Bookings and status changes show a preview first.
</p>

<p align="center">
  <a href="https://github.com/altipard/sevdesk-mcp/actions/workflows/ci.yml"><img src="https://github.com/altipard/sevdesk-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@altipard/sevdesk-mcp"><img src="https://img.shields.io/npm/v/@altipard/sevdesk-mcp" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white" alt="Node.js 24 or newer">
</p>

sevdesk-mcp connects your [sevdesk](https://sevdesk.de) account to an AI assistant such
as Claude Desktop, Claude Code, Cursor or VS Code. You ask in plain language, and the
assistant looks up the answer in sevdesk. For example:

- "Which invoices are overdue?"
- "Did the payment from ACME arrive?"
- "Which customers still owe us money, and how much?"
- "Show me all receipts from last month that are not booked yet."
- "Draft an invoice for ACME: 8 hours of consulting at 95 euros." (needs write mode)

> [!IMPORTANT]
> **Unofficial.** Not affiliated with, endorsed by or supported by sevdesk GmbH.
> "sevdesk" is a trademark of sevdesk GmbH.

Technically, sevdesk-mcp is a [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) server, the standard way AI programs connect to other services.

## Install

You need a sevdesk API token (see [Your API token](#your-api-token)). Then pick your program.

**Claude Desktop.** Download `sevdesk-mcp.mcpb` from the
[latest release](https://github.com/altipard/sevdesk-mcp/releases/latest) and double-click
it. Paste your token into the dialog that opens. Done.

**Claude Code.** You need Node.js 24 or newer. Store your token in the keychain first (see
[Your API token](#your-api-token)). Then run:

```sh
claude plugin install sevdesk --marketplace altipard/sevdesk-mcp
```

**Cursor, VS Code and others** (macOS and Linux). Run the setup in a terminal, without
Node.js or with Node.js 24 or newer:

```sh
curl -fsSL https://raw.githubusercontent.com/altipard/sevdesk-mcp/main/install.sh | sh
npx -y @altipard/sevdesk-mcp setup
```

Pick one of the two lines. The setup lists the programs it found: select them with the
space bar and press Enter to confirm. It then asks for the mode and your token, checks the
token with sevdesk and stores it in your keychain. It can also set up Claude Desktop and
Claude Code, so do not also add the extension or plugin, or you get two sevdesk servers.

**Windows** (untested): use the Claude Desktop extension. Manual setup, checksums and all
other options: [docs/install.md](docs/install.md).

## Your API token

The token is your key to sevdesk. In sevdesk, open **Settings > Users**, select your
administrator user and copy the **API token** (32 characters, digits and the letters a
to f).

Claude Desktop keeps the token in its own protected settings. Claude Code and the setup
use your system keychain, so the token does not end up in a configuration file. The
setup stores it there for you. On a Mac you can also store it yourself; this command
asks for the token:

```sh
security add-generic-password -U -s sevdesk-mcp -a api-token -w
```

Linux and other details: [docs/install.md](docs/install.md#api-token).

## Read only, or also write

By default the assistant can only **read**. It cannot change anything in sevdesk.

In **write** mode it can also create drafts (invoices, estimates, receipts), add and edit
contacts, and book payments. Drafts and contact changes happen right away. A draft stays a
draft: it gets no number and is not sent. Booking a payment or changing a status takes two
steps: first a preview of what will change, then the confirmation. Read the preview before
you agree. The confirmation does not protect you from a misled assistant, so stay in read
mode when in doubt ([why](docs/security.md)).

Sending invoices by e-mail, cancelling invoices and locking documents for good
(festschreiben) cannot be undone. These stay off until you switch them on on purpose.

To switch modes in Claude Desktop or Claude Code, change the mode in the extension or
plugin settings. For other programs and all details, see
[docs/security.md](docs/security.md#modes-per-client).

> [!CAUTION]
> Try write mode on test data first. Check the result in sevdesk before you use it on real
> bookkeeping.

Everything the assistant reads, such as customer names, IBANs and amounts, goes to your AI
program and from there to its provider.

## What it can do

- **Invoices:** find invoices, see what is open or overdue, get the PDF, create drafts.
- **Estimates and orders:** find them, create drafts, turn an estimate into an invoice.
- **Receipts:** find incoming invoices and receipts, record new ones with the file attached.
- **Contacts:** look up customers and suppliers, add new ones, update their details.
- **Bank:** see your accounts and balances, find transactions, book payments.
- **Reports:** sevdesk's list reports as PDF, and which tax rates and booking accounts fit
  together.

Full list of tools: [docs/tools.md](docs/tools.md).

## Problems?

- **The server does not start, or no sevdesk tools appear:** the token is missing, or
  Node.js is older than 24 (Claude Code, npx). Store the token again or rerun the setup.
- **Error 401 from sevdesk:** the token is wrong. Copy it again from sevdesk. In Claude
  Desktop, paste it into the extension settings. Elsewhere, store it again with the
  command above or rerun the setup with
  [`--replace-token`](docs/install.md#setup-options).
- **Some tools are missing:** you are in read mode. Write tools need
  [write mode](docs/security.md#modes-per-client).

Tip: ask the assistant to check the sevdesk connection. The answer also tells you the mode.
More help: [docs/install.md](docs/install.md#troubleshooting), or
[open an issue](https://github.com/altipard/sevdesk-mcp/issues).

## More

- [Install](docs/install.md): every way to install, every program, Windows, the token,
  troubleshooting
- [Tools](docs/tools.md): every tool and what it does
- [Security](docs/security.md): modes, confirmations and what they protect against
- [Remote (HTTP)](docs/remote-http.md): run it as a shared server with OAuth and Redis
- [Configuration](docs/configuration.md): all environment variables
- [Development](docs/development.md): build, tests, releases

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Zilicon IT Services.
