# Install

[Back to the README](../README.md)

You need a sevdesk API token (32 hex characters; sevdesk issues one per administrator).
Pick your client; the first way listed is the simplest.

| Client | Simplest way | Needs |
| --- | --- | --- |
| [Claude Code](#claude-code) | plugin | Node.js 24+, token in the keychain |
| [Claude Desktop](#claude-desktop) | `sevdesk-mcp.mcpb` extension, double-click | token typed into the extension; runs on Claude Desktop's built-in Node.js |
| [Cursor, VS Code, others](#cursor-vs-code-and-others) | [guided setup](#guided-setup) with npx | Node.js 24+ |
| any, without Node.js | [binary installer](#binary-installer), then the same setup | macOS or Linux (glibc) |

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
[guided setup](#guided-setup)) would run two sevdesk servers side by side. Remove
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

With Node.js 24 or newer, run the [guided setup](#guided-setup) in a terminal:

```sh
npx -y @altipard/sevdesk-mcp setup
```

It writes entries that start the server with npx and stores the token in the keychain.
Without Node.js, use the [binary installer](#binary-installer); it starts the same setup.

To add the entry by hand instead, store the [token](#api-token) in the keychain first.
Cursor (`~/.cursor/mcp.json`) and most other clients:

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
the full path to `npx` (`which npx`) or use the [binary installer](#binary-installer).
More clients and token options:
[Connect your MCP client by hand](#connect-your-mcp-client-by-hand).

## Guided setup

`sevdesk-mcp setup` registers the server with the MCP clients (agents) on your machine and
stores the token in the system keychain. Start it in a terminal in one of three ways:

```sh
npx -y @altipard/sevdesk-mcp setup   # with Node.js 24 or newer
curl -fsSL https://raw.githubusercontent.com/altipard/sevdesk-mcp/main/install.sh | sh  # without Node.js
sevdesk-mcp setup                    # binary already installed; run it again any time
```

If `~/.local/bin` is not on your `PATH`, call the binary by its full path,
`~/.local/bin/sevdesk-mcp setup`.

The [binary installer](#binary-installer) downloads the binary and then starts the setup.
The setup shows menus: arrow keys move, the space bar selects, Enter confirms. It asks, in
this order:

1. **Agents.** All [supported agents](#supported-agents) are listed. The ones found on
   this machine come first and are preselected; `a` selects all. An agent counts as found
   when its configuration directory exists, when Claude Desktop or Cursor is installed as a
   macOS app, or when `claude`, `cursor` or `code` is on your `PATH`.
2. **Scope.** Global (your user, every project) or this project (the current directory).
   The question only comes up when a selected agent has a project configuration; the other
   agents are skipped in project scope.
3. **Mode.** `read` (default), `write` or `full`. For `full` the setup reminds you that the
   irreversible tools also need `SEVDESK_ENABLE_TOOLS` in the entry's `env`; it does not set
   that variable.
4. **Replace?** Only when an agent already has a `sevdesk` entry with its own command or
   settings (see [Existing entries](#existing-entries)). Default: no.
5. **Token.** Typed with hidden input, checked for the format (32 hex characters) and then
   against sevdesk with a read-only request. A token sevdesk rejects is asked for again, up
   to three times; Enter skips. If sevdesk cannot be reached, the setup warns and stores
   the token anyway. A token already in the keychain is kept without asking.
6. **Token in an entry's env.** Only when an existing entry sets `SEVDESK_API_TOKEN`, which
   wins over the keychain. The setup names these entries and removes the variable from the
   ones you select. It asks only if the keychain holds a token afterwards.
7. **Skill.** Only when a selected agent reads skills: whether to copy the
   [sevdesk skill](#skill) as well. Default: yes.

Then it shows the plan: per agent the file and what happens to it, the mode, the token and
the skill folders. Nothing changes before you confirm the plan. Ctrl-C during the changes
waits until they are done. Restart the agents afterwards. A running Claude Code rewrites
`~/.claude.json` itself, so restart it right away and check with `claude mcp list`.

The entry starts the server with the binary's absolute path (binary installer) or with
`npx -y @altipard/sevdesk-mcp` (npx), plus `SEVDESK_MODE` in its `env`. The token never goes
into a client configuration. On Linux the keychain needs `secret-tool` (`libsecret-tools`
on Debian and Ubuntu). Without a supported keychain the setup stores no token and says how
to supply it (see [API token](#api-token)).

### Existing entries

The setup never deletes other servers and changes only the entry named `sevdesk`:

- **No entry:** it is added. A new configuration file gets mode 600.
- **An entry with the same start command:** the mode is updated and every other `env`
  variable stays. If nothing differs, the file stays untouched. An entry written by the npx
  setup has another command than one written by the binary, so switching between the two
  counts as "own command" below.
- **An entry with its own command or settings** (another command or arguments, settings
  such as `disabled`, `autoApprove` or `timeout`, `env` values that are not strings): it
  stays unchanged, and the setup prints the entry to add by hand. With your confirmation or
  `--replace-entries` the setup replaces it; its `env` stays, and the plan names the
  settings it drops.
- **A remote (URL) entry:** never changed.
- **`SEVDESK_API_TOKEN` in the entry's `env`:** the plan names it. It stays unless you
  remove it in the menu or with `--remove-env-token`. The backup still holds the token in
  plain text; the setup reminds you to delete the backup once the agent works.
- **A file that is not valid JSON, a symbolic link or not a regular file:** skipped; the
  setup prints the entry to add by hand.

Writing drops comments in TOML and YAML files, and in JSON files inside the block of server
entries. The setup tries the change on a copy first and says so in the plan, before
anything is written.

Before a file changes, the setup copies it to `<file>.backup-<timestamp>` next to it, with
mode 600. In project scope the backups go to `$XDG_STATE_HOME/sevdesk-mcp/backups` (default
`~/.local/state/sevdesk-mcp/backups`) instead, so they do not end up in the repository.
Project scope also warns that the entry holds the binary's absolute path, which usually
contains your user name; the npx entry has no path. The new file is written next to the
original, checked and then renamed into place. If a running client changes the file
meanwhile, the setup starts over once and otherwise reports an error.

### Supported agents

The setup writes the configuration with [add-mcp](https://www.npmjs.com/package/add-mcp)
and supports every agent it knows. The name is the value for `--agents`.

| Agent | Name | Project file |
| --- | --- | --- |
| Antigravity | `antigravity` | |
| Claude Code | `claude-code` | `.mcp.json` |
| Claude Desktop | `claude-desktop` | |
| Cline CLI | `cline-cli` | |
| Cline VSCode Extension | `cline` | |
| Codex | `codex` | `.codex/config.toml` |
| Cursor | `cursor` | `.cursor/mcp.json` |
| Factory Droid | `factory-droid` | `.factory/mcp.json` |
| fx | `fx` | |
| Gemini CLI | `gemini-cli` | `.gemini/settings.json` |
| GitHub Copilot CLI | `github-copilot-cli` | `.mcp.json` |
| Goose | `goose` | |
| Grok Build | `grok-build` | `.grok/config.toml` |
| Hermes Agent | `hermes` | |
| Junie | `junie` | `.junie/mcp/mcp.json` |
| Kilo Code | `kilo-code` | `kilo.json` |
| Kimi Code | `kimi-code` | `.kimi-code/mcp.json` |
| Kiro CLI | `kiro-cli` | `.kiro/settings/mcp.json` |
| Mastra Code | `mastracode` | `.mastracode/mcp.json` |
| MCPorter | `mcporter` | `config/mcporter.json` |
| OpenCode | `opencode` | `opencode.jsonc` |
| Pi | `pi` | `.pi/mcp.json` |
| VS Code | `vscode` | `.vscode/mcp.json` |
| Windsurf | `windsurf` | |
| Zed | `zed` | `.zed/settings.json` |

Agents without a project file can only be set up globally.

### Skill

The `sevdesk` skill guides the assistant through invoices, vouchers, contacts and open
items. The setup copies it into the folder each agent reads skills from:

| Agents | Global | Project |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/sevdesk` (or `$CLAUDE_CONFIG_DIR/skills/sevdesk`) | `.claude/skills/sevdesk` |
| Windsurf | `~/.codeium/windsurf/skills/sevdesk` | `.windsurf/skills/sevdesk` |
| Goose | `$XDG_CONFIG_HOME/goose/skills/sevdesk` (default `~/.config`) | `.goose/skills/sevdesk` |
| Codex, Cursor, Gemini CLI, OpenCode, Cline VSCode Extension, GitHub Copilot CLI, Zed | `~/.agents/skills/sevdesk` | `.agents/skills/sevdesk` |

Other agents get no skill. Running the setup again updates a skill folder it installed
itself. A `sevdesk` folder installed some other way stays, and the setup reports it as
skipped. In Claude Code, the [plugin](#claude-code) brings the skill too, but it also
registers the server: use either the plugin or the setup for Claude Code, not both.

### Setup options

Without options the setup asks. Options answer a question in advance; with `--yes` it asks
nothing and uses the defaults for whatever is not given.

| Option | Meaning |
| --- | --- |
| `--agents=LIST` | Comma-separated agent names, `detected` or `all`. Default: ask; without prompts: `detected`. |
| `--scope=SCOPE` | `global` (default) or `project` (current directory; only agents with a project file). |
| `--mode=MODE` | `read` (default), `write` or `full`. |
| `--replace-entries` | Also replace a `sevdesk` entry with its own command; its `env` is kept either way. |
| `--replace-token` | Ask for a new token even if one is in the keychain. |
| `--remove-env-token` | Remove `SEVDESK_API_TOKEN` from the `env` of existing entries. Default: ask; without prompts: keep it and warn. |
| `--token-stdin` | Read the token from stdin. Needs `--yes`. |
| `--skip-token` | Leave the keychain alone. |
| `--no-verify` | Store the token without checking it with sevdesk. |
| `--skill`, `--no-skill` | Copy the sevdesk skill for agents that read skills, or not. Default: ask; without prompts: no. |
| `-y`, `--yes` | No prompts: run with the options and defaults. |
| `-h`, `--help` | Show the help. |

Without a terminal (CI, a script), the setup shows no prompts and stops with exit code 2
unless you pass `--yes`. Without prompts it stores a token only with `--token-stdin`;
`--replace-token` alone keeps the stored token. Example, with the token already in the
keychain:

```sh
sevdesk-mcp setup --yes --agents=cursor,vscode --mode=read --no-skill
```

Exit codes: 0 done, 1 something failed, 2 wrong usage, 130 cancelled.

## Binary installer

For macOS and Linux with glibc (x64 and arm64), no Node.js needed:

```sh
curl -fsSL https://raw.githubusercontent.com/altipard/sevdesk-mcp/main/install.sh | sh
```

It downloads the release for your platform, verifies it against the release's
`SHA256SUMS` (nothing is installed on a mismatch, or if the archive holds anything but the
binary) and installs it to `~/.local/bin`. It prefers the `sevdesk-mcp-<os>-<arch>.tar.xz`
archive when the release lists one and the machine unpacks xz - a quarter of the bytes -
and otherwise takes the single binary, so older releases work unchanged. With a terminal it
then starts the [guided setup](#guided-setup) and passes `--mode`,
`--replace-token`, `--replace-entries` and `--no-verify` on to it. If the setup fails or
you cancel it, the binary stays installed; run `sevdesk-mcp setup` again later.

Without a terminal, or with `--no-setup`, it only installs and prints the next step. A
release older than the setup gets the same treatment: the installer says that this release
has no guided setup, prints the command to store the token in the keychain, and leaves the
client configuration to you (see
[Connect your MCP client by hand](#connect-your-mcp-client-by-hand)).

### Installer options

Options, passed after `sh -s --`:

| Option | Meaning |
| --- | --- |
| `--dry-run` | Show platform, release and target without downloading or changing anything. |
| `--no-setup` | Install only, skip the guided setup. |
| `--mode=MODE` | Mode for the client entries: `read`, `write` or `full`. Default: the setup asks. |
| `--replace-token` | Ask for a new token even if one is already in the keychain. |
| `--replace-entries` | Also replace a `sevdesk` entry that has its own command or settings. |
| `--no-verify` | Store the token without checking it against the sevdesk API. |
| `-h`, `--help` | Show the help. |

The other [setup options](#setup-options) are not passed through; run `sevdesk-mcp setup`
with them after installing.

Environment variables, set for `sh`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `INSTALL_DIR` | `~/.local/bin` | Target directory, absolute path, created if missing, must be writable. |
| `SEVDESK_MCP_VERSION` | `latest` | Release to install, for example `0.2.0` (tags have no `v` prefix). |
| `SEVDESK_MODE` | the setup asks | Same as `--mode`; the option wins. |
| `NO_COLOR` | | Set to a non-empty value to disable colored output. |

```sh
curl -fsSL https://raw.githubusercontent.com/altipard/sevdesk-mcp/main/install.sh \
  | INSTALL_DIR="$HOME/bin" SEVDESK_MCP_VERSION=0.2.0 sh -s -- --no-setup
```

The installer needs `curl` and `sha256sum` or `shasum`; on Linux also `xz` to use the
archive, otherwise it takes the plain binary. Release binaries exist for
`darwin-arm64`, `darwin-x64`, `linux-x64` and `linux-arm64`; under Rosetta it picks the
native arm64 binary. The Linux binaries are built against glibc, so on musl systems such as
Alpine use npx instead.

### Manual download

Every release carries `sevdesk-mcp-<os>-<arch>`, the same binary compressed as
`sevdesk-mcp-<os>-<arch>.tar.xz` (about a quarter of the bytes; the archive holds exactly
one file `sevdesk-mcp`, mode 0755), and `SHA256SUMS` over both:

```sh
base=https://github.com/altipard/sevdesk-mcp/releases/latest/download
asset=sevdesk-mcp-linux-x64
curl -fsSLO "$base/$asset.tar.xz"
curl -fsSLO "$base/SHA256SUMS"
grep " $asset.tar.xz\$" SHA256SUMS | sha256sum -c -   # macOS: shasum -a 256 -c -
tar -xf "$asset.tar.xz"   # Linux needs xz installed; macOS unpacks xz itself
mkdir -p ~/.local/bin
install -m 755 sevdesk-mcp ~/.local/bin/sevdesk-mcp
```

Without xz, or for releases from before the archives, take the plain binary instead:

```sh
curl -fsSLO "$base/$asset"
grep " $asset\$" SHA256SUMS | sha256sum -c -
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
goes into a repository. The [guided setup](#guided-setup) stores it for you; by hand:

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
[guided setup](#guided-setup) writes these entries for you, and the plugin and the
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
  [API token](#api-token) (`-U` replaces the entry) or run `sevdesk-mcp setup` with
  `--replace-token`.
- **The setup cannot check the token** (offline, proxy): it warns and stores it anyway;
  pass `--no-verify` to skip the check.
- **The setup skipped an agent:** the report says why and, for an entry it left alone,
  prints the entry to add by hand (see [Existing entries](#existing-entries)).
- **"no terminal for the prompts":** run the setup in a terminal, or pass `--yes` with the
  options (see [Setup options](#setup-options)).
- **Write tools are missing:** the server runs in `read` mode. Set `write` (see
  [Security](security.md)).
- **`full` shows no irreversible tools:** they are off by default and also need
  `SEVDESK_ENABLE_TOOLS`, see [Security](security.md).
- **Two sevdesk servers:** the plugin and a `claude mcp add` entry are both active; remove
  one (see [Claude Code](#claude-code)).
