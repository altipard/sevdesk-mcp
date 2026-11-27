# Security model

[Back to the README](../README.md)

An accounting system is not a place for an assistant to improvise, so the defaults are
strict and every relaxation is an explicit setting. The settings named here are described
in [Configuration](configuration.md); the tools and their classes in [Tools](tools.md).

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
  `sevdesk_api_request` it shows only the operation, method and path. For clients that
  cannot ask, the operator's explicit listing in `SEVDESK_ENABLE_TOOLS` (or of the
  operation in `SEVDESK_API_ALLOW`) counts as the release; then no human sees the action
  before it runs.
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
- **Data flow.** Everything a tool reads (customer names, IBANs, amounts, PDFs) goes to
  your MCP client and from there to the client's model provider.

> [!IMPORTANT]
> **What holds against a manipulated model.** A confirmation token proves that a preview
> was fetched for exactly these arguments, not that a human read it: a model following
> injected instructions can make both calls itself. Elicitation only helps where the
> client actually asks a human; on clients that cannot ask, the operator release in
> `SEVDESK_ENABLE_TOOLS` stands in and no human sees the action. The hard limits are the
> mode and, over HTTP, the token's scopes (see [Remote (HTTP)](remote-http.md)). Give the
> server no more than the work needs.

## Modes per client

- **Claude Desktop extension:** `read` (default) or `write`, in lower case, set in the
  extension's settings. `full` needs a
  [manual configuration](install.md#connect-your-mcp-client-by-hand).
- **Claude Code plugin:** `read`, `write` or `full`, chosen when you enable the plugin;
  change it later under `/plugin` > Installed > Configure options.
- **Guided setup and manual entries:** `SEVDESK_MODE` in the client's `env` block. The
  [setup](install.md#guided-setup) asks for the mode or takes it from `--mode`.

In every case `full` registers the irreversible tools only once they are also listed in
`SEVDESK_ENABLE_TOOLS`.
