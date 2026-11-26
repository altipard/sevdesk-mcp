import type { AuthInfo } from "@modelcontextprotocol/server";
import { type Config, ConfigError, confirmSecretFor } from "../config.js";
import { type AuditLog, createAuditLog } from "./audit.js";
import { type ConfirmationSigner, createConfirmationSigner } from "./confirm.js";
import { InMemoryNonceStore, type NonceStore } from "./nonce-store.js";
import { type Rights, rightsForRequest, subjectFor, type Transport } from "./rights.js";

/**
 * Policy state that must live exactly once per process: the HMAC key, the
 * nonce store and the audit sink. Entrypoints create it at startup and hand
 * it to every server instance. Creating it per server would void replay
 * protection, because the HTTP entrypoint builds a server per request.
 */
export interface PolicyRuntime {
  readonly transport: Transport;
  readonly signer: ConfirmationSigner;
  readonly nonces: NonceStore;
  readonly audit: AuditLog;
  /** Clock shared by token expiry and nonce lifetimes. */
  readonly now: () => number;
}

export interface PolicyRuntimeOptions {
  transport: Transport;
  /** Overrides for tests or a shared backend. */
  nonces?: NonceStore;
  audit?: AuditLog;
  secret?: Buffer;
  now?: () => number;
}

/**
 * HTTP needs an explicit NonceStore: with SEVDESK_CONFIRM_SECRET shared,
 * tokens stay valid across restarts and instances, but an in-memory store
 * forgets its nonces, so a token could be replayed against another instance
 * or after a restart. The in-memory default is for stdio and tests only.
 */
export function createPolicyRuntime(config: Config, options: PolicyRuntimeOptions): PolicyRuntime {
  if (options.transport === "http" && options.nonces === undefined) {
    throw new ConfigError([
      "HTTP transport needs a shared NonceStore; the in-memory store is only for stdio",
    ]);
  }
  const secret = options.secret ?? confirmSecretFor(config, options.transport);
  const now = options.now ?? Date.now;
  return {
    transport: options.transport,
    now,
    signer: createConfirmationSigner({ secret, ttlMs: config.confirmTtlSeconds * 1000, now }),
    nonces: options.nonces ?? new InMemoryNonceStore({ now }),
    audit:
      options.audit ??
      createAuditLog({
        redact: [config.sevdeskApiToken, ...(config.confirmSecret ? [config.confirmSecret] : [])],
      }),
  };
}

/** Policy for one server instance: one stdio connection or one HTTP request. */
export interface RequestPolicy {
  readonly config: Config;
  readonly runtime: PolicyRuntime;
  readonly rights: Rights;
  readonly subject: string;
}

export function requestPolicy(
  config: Config,
  runtime: PolicyRuntime,
  authInfo: AuthInfo | undefined,
): RequestPolicy {
  return {
    config,
    runtime,
    rights: rightsForRequest(config.mode, runtime.transport, authInfo),
    subject: subjectFor(runtime.transport, authInfo),
  };
}
