# Configuration

[Back to the README](../README.md)

All configuration comes from environment variables; see [`.env.example`](../.env.example).
Empty values count as unset. The first table applies to both transports, the second only
to the [HTTP transport](remote-http.md). For local clients the variables go into the
client's `env` block (see [Install](install.md#other-settings)).

## All transports

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

What the mode and tool lists mean in practice: [Security](security.md). The live smoke:
[Development](development.md#live-smoke-test).

## HTTP transport only

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

The [installer](install.md#installer-options) reads a few variables of its own
(`INSTALL_DIR`, `SEVDESK_MCP_VERSION`, `NO_COLOR`); the server ignores them.
