# Install

[Back to the README](../README.md)

You need a sevdesk API token (32 hex characters; sevdesk issues one per administrator).
Pick your client; the first way listed is the simplest.

| Client | Simplest way | Needs |
| --- | --- | --- |
| [Claude Code](#claude-code) | plugin | Node.js 24+, token in the keychain |
| [Claude Desktop](#claude-desktop) | `sevdesk-mcp.mcpb` extension, double-click | token typed into the extension; runs on Claude Desktop's built-in Node.js |
| [Cursor, VS Code, others](#cursor-vs-code-and-others) | npx entry in the client config | Node.js 24+, token in the keychain |
| any, without Node.js | [binary installer](#binary-installer) | macOS or Linux (glibc) |

## Claude Code

Store the [token](#api-token) in the keychain first. Then, from your shell (Claude Code
v2.1.292 or later), one command adds the marketplace and installs the plugin:

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
[keychain](#api-token). It also brings the `sevdesk` skill, which guides the assistant
through invoices, vouchers, contacts and open items and through the preview and
confirmation of changes. Without the plugin, register the server with `claude mcp add`
(see [Connect your MCP client by hand](#connect-your-mcp-client-by-hand)).

Use one way, not both: the plugin and a `claude mcp add` entry (also written by the
[binary installer](#binary-installer)) would run two sevdesk servers side by side. Remove
the entry with `claude mcp remove --scope user sevdesk`, or the plugin with
`claude plugin uninstall sevdesk@sevdesk-mcp`.

## Claude Desktop

Download `sevdesk-mcp.mcpb` from the
[latest release](https://github.com/altipard/sevdesk-mcp/releases/latest), double-click it
and enter your token in the dialog Claude Desktop shows. The extension keeps the token in
its own settings, not in the keychain entry below. It offers the modes `read` (default) and
`write`, in lower case; an unknown value stops the server from starting. `full` is only
available through a [manual configuration](#connect-your-mcp-client-by-hand).

To check the download before opening it:

```sh
base=https://github.com/altipard/sevdesk-mcp/releases/latest/download
curl -fsSLO "$base/sevdesk-mcp.mcpb"
curl -fsSLO "$base/SHA256SUMS"
grep ' sevdesk-mcp.mcpb$' SHA256SUMS | shasum -a 256 -c -   # Linux: sha256sum -c -
gh attestation verify sevdesk-mcp.mcpb --repo altipard/sevdesk-mcp
```

## Cursor, VS Code and others

Store the [token](#api-token) in the keychain, then add the server with npx (Node.js 24 or
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
options: [Connect your MCP client by hand](#connect-your-mcp-client-by-hand).

## Binary installer

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
own command or env stays unchanged unless you pass `--replace-entries`: carrying its env
over would put the values on a command line, and they are never printed. Remote (URL)
entries are never changed. Changing JSON configurations needs `jq` or `python3`; files that
are not valid JSON are left alone and the installer prints the entry to add by hand.
Without a terminal, or with `--no-setup`, it installs only and prints the next steps.

### Installer options

Options, passed after `sh -s --`:

| Option | Meaning |
| --- | --- |
| `--dry-run` | Show platform, release and target without downloading or changing anything. |
| `--no-setup` | Install only, skip the keychain and MCP client setup. |
| `--mode=MODE` | Mode for the client entries: `read` (default), `write` or `full`. |
| `--replace-token` | Ask for a new token even if one is already in the keychain. |
| `--replace-entries` | Replace a Claude Code entry that has its own command or env (its env is not kept; `~/.claude.json` is copied first, mode 600). |
| `--no-verify` | Store the token without checking it against the sevdesk API. |
| `-h`, `--help` | Show the help. |

Environment variables, set for `sh`:

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

### Manual download

Every release carries `sevdesk-mcp-<os>-<arch>` plus `SHA256SUMS`:

```sh
base=https://github.com/altipard/sevdesk-mcp/releases/latest/download
asset=sevdesk-mcp-linux-x64
curl -fsSLO "$base/$asset"
curl -fsSLO "$base/SHA256SUMS"
grep " $asset\$" SHA256SUMS | sha256sum -c -   # macOS: shasum -a 256 -c -
mkdir -p ~/.local/bin
install -m 755 "$asset" ~/.local/bin/sevdesk-mcp
```

### From source

Node.js 24 or newer:

```sh
git clone https://github.com/altipard/sevdesk-mcp.git
cd sevdesk-mcp
npm ci
npm run build
node dist/bin/stdio.js
```

## API token

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

## Connect your MCP client by hand

All clients below start the server as a local process over stdio; to run it as a shared
service instead, see [Remote (HTTP)](remote-http.md). The
[binary installer](#binary-installer) writes these entries for you, and the plugin and the
Desktop extension need none; the snippets below are for doing it by hand, including `full`
mode and other settings. Replace `/Users/you/.local/bin/sevdesk-mcp` with the absolute path
of your binary (`echo ~/.local/bin/sevdesk-mcp`).

> [!WARNING]
> Never put the API token into a project or workspace file that goes into a repository
> (`.cursor/mcp.json`, `.vscode/mcp.json`, `.mcp.json`). Prefer the keychain. Without one,
> use user-level configuration only: in Cursor reference an environment variable with
> `${env:SEVDESK_API_TOKEN}`, in VS Code let it prompt with `${input:…}` (below).

**npx instead of the binary.** Set `"command": "npx"` and
`"args": ["-y", "@altipard/sevdesk-mcp"]`, as in
[Cursor, VS Code and others](#cursor-vs-code-and-others).

### Windows

Windows is untested. It has no release binary and no keychain lookup: use npx through
`cmd`, for example `"command": "cmd", "args": ["/c", "npx", "-y", "@altipard/sevdesk-mcp"]`,
and supply the token as above. Claude Desktop has no token reference, so on Windows the
token sits in plain text in its user configuration file. Cursor's `${env:…}` can stay empty
when Cursor is started from the GUI rather than a shell that has the variable. Claude
Desktop reads `%APPDATA%\Claude\claude_desktop_config.json`, the VS Code user
configuration lives in `%APPDATA%\Code\User\mcp.json`, and Cursor uses
`%USERPROFILE%\.cursor\mcp.json`.

### Claude Desktop config

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

### Claude Code entry

```sh
claude mcp add --scope user sevdesk --env SEVDESK_MODE=read -- ~/.local/bin/sevdesk-mcp
```

Leave out `--scope user` to register it for the current project only. Do not combine this
with the plugin (see [Claude Code](#claude-code)).

### Cursor config

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

### VS Code config

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

Without a keychain, VS Code can prompt for the token once and store it securely; the file
then holds only the reference, not the token:

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

### Other settings

Other settings from [Configuration](configuration.md), for example
`SEVDESK_DENIED_TOOLS=get_report`, go into the same `env` block.

> [!TIP]
> Ask the assistant to call `get_account_info` first. It checks the connection and tells
> you which mode the server runs in.

## Troubleshooting

- **No sevdesk tools, or the server does not start:** no token (neither in the keychain
  nor in `SEVDESK_API_TOKEN`), or Node.js older than 24 for npx and the plugin
  (`node --version`). In the Claude Desktop extension, a mode other than `read` or `write`
  in lower case also stops the server. The client's MCP log shows the reason.
- **HTTP 401 from sevdesk:** the token is wrong. Store it again with the command under
  [API token](#api-token) (`-U` replaces the entry) or run the installer with
  `--replace-token`.
- **The installer cannot check the token** (offline, proxy): it stores it anyway; pass
  `--no-verify` to skip the check.
- **Write tools are missing:** the server runs in `read` mode. Set `write` (see
  [Security](security.md)).
- **`full` shows no irreversible tools:** they are off by default and also need
  `SEVDESK_ENABLE_TOOLS`, see [Security](security.md).
- **Two sevdesk servers:** the plugin and a `claude mcp add` entry are both active; remove
  one (see [Claude Code](#claude-code)).
