# Remote (HTTP)

[Back to the README](../README.md)

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
  Confirmation tokens are bound to the caller (`sub`, else client ID). See
  [Security](security.md) for modes and confirmations.
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

## Run it

The image built from [`Dockerfile`](../Dockerfile) runs the HTTP server and holds no
secrets; configuration comes from the environment at run time.
[`compose.yaml`](../compose.yaml) runs it locally with a Redis set up as described below,
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
stop the server at startup with a configuration error that names them. The HTTP server
reads the [common variables](configuration.md#all-transports) plus
[its own](configuration.md#http-transport-only).

## Redis

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

## Shutdown

On `SIGTERM` the server stops accepting MCP requests (they get HTTP 503, `/healthz`
reports draining), waits up to 10 seconds for in-flight requests and exits at the latest
after about 15 seconds. Give it more time than that before `SIGKILL`:
`stop_grace_period: 20s` in compose (already set) and `terminationGracePeriodSeconds` of
at least 20 on Kubernetes.
