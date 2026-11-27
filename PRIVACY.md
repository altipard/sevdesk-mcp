# Privacy

[Back to the README](README.md)

sevdesk-mcp is software you run yourself. Its authors operate no server for it, receive no
data from it and have no access to your sevdesk account. This page describes what the
software does with your data, as of the code in this repository. It is not legal advice.

## Your sevdesk API token

The local server (stdio, what every desktop client starts) takes the token from the first
of these that is set:

1. The environment variable `SEVDESK_API_TOKEN`. The Claude Desktop extension passes the
   token you enter in its settings this way; the extension marks that field as sensitive,
   and Claude Desktop stores it.
2. Your system keychain: on macOS the login keychain (read with `/usr/bin/security`), on
   Linux the Secret Service (read with `secret-tool`). The entry has the service
   `sevdesk-mcp` and the account `api-token`.

The token is sent only to the sevdesk API, in the `Authorization` header of each request.
The base URL is `https://my.sevdesk.de/api/v1` unless you set `SEVDESK_BASE_URL`; plain
http is refused except for localhost, and redirects are refused, so the token cannot be
forwarded to another host. The token is removed from the environment of every program the
server or the setup starts, and log output replaces it with a placeholder.

## Network connections

The server process connects to the sevdesk API base URL and nowhere else. There is no
telemetry, no analytics, no crash reporting and no update check in it. How it is started
can add connections of its own: see npx below.

`sevdesk-mcp setup` additionally sends one read-only request to
`https://my.sevdesk.de/api/v1/Tools/bookkeepingSystemVersion` to check that sevdesk accepts
the token before it stores it.

## Your bookkeeping data

What a tool reads or changes in sevdesk, for example contact names, addresses, IBANs,
amounts, invoice texts and PDF files, is returned to your MCP client (Claude Desktop,
Claude Code, Cursor, VS Code and others). The client passes it to its AI model and so to
the model's provider. That provider's privacy terms apply to it, not this page. sevdesk's
own privacy policy applies to the data in your sevdesk account:
<https://sevdesk.de/datenschutz/>.

The local server stores no bookkeeping data on disk; it holds it in memory while it
handles a request. Its log lines go to stderr, which the client may save in its own log
files. They record events such as start, stop, failed tools and audit events (who called
which tool on which object, and the outcome, without arguments or results); an error
message from sevdesk can appear in them. The token is masked in every log line.

## What the setup writes

`sevdesk-mcp setup` (also started by `install.sh` and `npx -y @altipard/sevdesk-mcp setup`)
writes, after you confirm:

- **Your keychain:** the token, in the entry named above.
- **The MCP configuration file of each program you select**, in your home directory (for
  example `~/.claude.json` for Claude Code) or, if you choose, in the current project. The
  entry holds the start command and `SEVDESK_MODE`, not the token. If an existing entry
  already sets `SEVDESK_API_TOKEN`, the setup offers to remove it; it keeps it when there is
  no token in the keychain to use instead.
- **A backup of each configuration file before it changes it**, readable only by you
  (mode 0600). For a file in your home directory the backup sits next to it as
  `<file>.backup-<timestamp>`. For a project file it goes to
  `$XDG_STATE_HOME/sevdesk-mcp/backups` (default `~/.local/state/sevdesk-mcp/backups`), not
  into the project. A backup keeps whatever the file held, including a token that was in
  it; the setup names such backups so you can delete them.
- **Two short-lived copies of a configuration file**, which hold a token if the file does:
  a test copy in `$XDG_STATE_HOME/sevdesk-mcp/tmp` (mode 0600, in a directory only you can
  read) that shows whether writing would drop comments, and a staging file next to the
  configuration that replaces it in one step. Both are removed when the run ends; the
  setup removes old test copies from that folder when it makes a new one.
- **The sevdesk skill**, if you choose it: instruction files in the program's skill folder,
  for example `~/.claude/skills/sevdesk` or `~/.agents/skills/sevdesk`.

## What the installers download

- **`install.sh`** downloads the release binary for your system and its `SHA256SUMS` from
  the GitHub releases of `altipard/sevdesk-mcp` (`https://github.com/altipard/sevdesk-mcp/releases`),
  checks the checksum and installs the binary into `~/.local/bin` (or `INSTALL_DIR`). It
  asks GitHub which release is the latest unless you set `SEVDESK_MCP_VERSION`.
- **`npx -y @altipard/sevdesk-mcp`** downloads the package and its dependencies from your
  npm registry, by default `https://registry.npmjs.org`. Client entries that start the
  server through npx, including the Claude Code plugin, ask that registry for the current
  version on every start, even when the package is already cached.
- **The Claude Desktop extension** (`sevdesk-mcp.mcpb`) is downloaded by you from the
  GitHub releases and contains everything it needs.

GitHub and npm see these downloads like any other, including your IP address.

## Remote (HTTP) mode

When someone runs sevdesk-mcp as a shared server ([Remote (HTTP)](docs/remote-http.md)),
that operator, not the authors, is responsible for the data. In this mode:

- The server uses one sevdesk token from its own `SEVDESK_API_TOKEN` for all callers;
  everyone with a valid access token acts as that sevdesk user.
- Callers log in with the operator's OAuth authorization server. The server fetches its
  signing keys from `OAUTH_JWKS_URL` and checks access tokens; it does not see passwords.
- The operator's Redis stores single-use confirmation nonces and locks for irreversible
  actions, not bookkeeping data.
- Logs, including audit events (who called which tool on which object, and the outcome,
  without arguments or results), go to stdout, where the operator collects them.

Ask the operator of that server how they handle your data.

## Contact

Questions or concerns: [open an issue](https://github.com/altipard/sevdesk-mcp/issues).
