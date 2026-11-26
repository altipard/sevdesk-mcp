import {
  acceptedContent,
  type CallToolResult,
  CLIENT_CAPABILITIES_META_KEY,
  type ClientCapabilities,
  type InputRequiredResult,
  inputRequired,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { Logger } from "../logger.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { errorResult, okResult } from "../tools/result.js";
import type { AuditOutcome } from "./audit.js";
import type { OperationClass } from "./classification.js";
import { argumentHash, type RejectReason } from "./confirm.js";
import {
  allows,
  minRights,
  type Rights,
  requiredRights,
  rightsForRequest,
  subjectFor,
  UNIDENTIFIED_SUBJECT,
} from "./rights.js";
import type { RequestPolicy } from "./runtime.js";

/** Idempotency window for X actions per target, e.g. one e-mail per invoice. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** Key of the approval question in elicitation input requests/responses. */
export const APPROVAL_KEY = "approve";

export const CONFIRMATION_TOKEN_DESCRIPTION =
  "Leave empty on the first call: it returns a preview and a confirmation_token. " +
  "Repeat the call with the same arguments and that token to execute.";

export type ToolOutput = Record<string, unknown>;

/** One attempt of a guarded action, as seen by the policy. */
export interface GuardedAction {
  /** Name the confirmation token is bound to (tool or tool:operationId). */
  readonly key: string;
  /** Tool name for audit events. */
  readonly tool: string;
  readonly operationId?: string | undefined;
  readonly class: OperationClass;
  /** Arguments without confirmation_token; hashed into the token. */
  readonly args: Record<string, unknown>;
  readonly confirmationToken?: string | undefined;
  readonly targetId?: string | undefined;
  /**
   * X only: the operator released this action explicitly, which stands in
   * for human approval on clients without elicitation. Tools: listed in
   * SEVDESK_ENABLE_TOOLS. Fallback: the operation listed in SEVDESK_API_ALLOW.
   */
  readonly explicitlyAllowed: boolean;
  /** Human-readable summary for the approval question. */
  readonly summary: string;
  readonly preview?: (() => Promise<ToolOutput>) | undefined;
  readonly execute: () => Promise<ToolOutput>;
}

export interface GuardEnv {
  readonly policy: RequestPolicy;
  readonly server: McpServer;
  readonly logger: Logger;
}

const REJECT_TEXT: Record<RejectReason, string> = {
  malformed: "is not a valid confirmation token",
  bad_signature: "has an invalid signature",
  expired: "has expired",
  wrong_tool: "was issued for a different action",
  wrong_arguments: "was issued for different arguments",
  wrong_subject: "was issued to a different user",
};

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

interface CallIdentity {
  readonly rights: Rights;
  readonly subject: string;
}

/**
 * Rights and subject of this call. On HTTP both are derived again from the
 * request's own token, like at registration: rights are the minimum of
 * both, and a subject that differs from the one the server was built for
 * (or none at all) means no rights.
 */
function callIdentity(env: GuardEnv, ctx: ServerContext): CallIdentity {
  const { policy } = env;
  if (policy.runtime.transport === "stdio") {
    return { rights: policy.rights, subject: policy.subject };
  }
  const authInfo = ctx.http?.authInfo;
  const subject = subjectFor("http", authInfo);
  if (subject === undefined || subject !== policy.subject) {
    return { rights: "none", subject: subject ?? UNIDENTIFIED_SUBJECT };
  }
  return {
    rights: minRights(policy.rights, rightsForRequest(policy.config.mode, "http", authInfo)),
    subject,
  };
}

/**
 * Whether the client can answer a form elicitation for this request: the
 * per-request envelope on 2026-07-28, the initialize capabilities on the
 * 2025 protocol. Checked before returning `inputRequired`, which the SDK
 * otherwise answers with -32021.
 */
export function clientSupportsElicitation(server: McpServer, ctx: ServerContext): boolean {
  // The SDK types the envelope as {}; the key is part of 2026-07-28.
  const envelope = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.[
    CLIENT_CAPABILITIES_META_KEY
  ] as ClientCapabilities | undefined;
  const capabilities = envelope ?? server.server.getClientCapabilities();
  const elicitation = capabilities?.elicitation as Record<string, unknown> | undefined;
  if (elicitation === undefined || elicitation === null) return false;
  // An empty object means form mode (2025-06-18); url-only clients cannot
  // show the form.
  return Object.keys(elicitation).length === 0 || "form" in elicitation;
}

type ApprovalState = "approved" | "declined" | "pending";

function approvalState(ctx: ServerContext): ApprovalState {
  const responses = ctx.mcpReq.inputResponses;
  if (responses === undefined || !(APPROVAL_KEY in responses)) return "pending";
  const content = acceptedContent(responses, APPROVAL_KEY);
  return content?.confirm === true ? "approved" : "declined";
}

/** Definite rejections by sevdesk free the idempotency key; unknown outcomes keep it. */
function isDefiniteRejection(error: unknown): boolean {
  return (
    error instanceof SevdeskError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500
  );
}

/**
 * Runs one tool call under the policy: rights, confirmation token, human
 * approval, single use, idempotency and audit, depending on the class.
 */
export async function runGuarded(
  env: GuardEnv,
  ctx: ServerContext,
  action: GuardedAction,
): Promise<CallToolResult | InputRequiredResult> {
  const { policy, logger } = env;
  const { runtime } = policy;
  const identity = callIdentity(env, ctx);
  const audited = action.class !== "R" && action.class !== "R+";
  const audit = (outcome: AuditOutcome, extra: { reason?: string; status?: number } = {}) => {
    if (!audited) return;
    runtime.audit.record({
      subject: identity.subject,
      tool: action.tool,
      operationId: action.operationId,
      targetId: action.targetId,
      class: action.class,
      outcome,
      ...extra,
    });
  };

  if (!allows(identity.rights, action.class)) {
    audit("denied", { reason: "insufficient_rights" });
    return failure(
      `${action.tool} needs ${requiredRights(action.class)} rights (SEVDESK_MODE and token scopes); ` +
        "this server or token does not grant them.",
    );
  }

  const execute = async (onError?: (error: unknown) => Promise<void>) => {
    try {
      const output = await action.execute();
      audit("ok");
      return okResult(output);
    } catch (error) {
      const status = error instanceof SevdeskError ? error.status : undefined;
      audit("error", {
        reason: error instanceof SevdeskError ? error.kind : "internal",
        ...(status !== undefined && { status }),
      });
      await onError?.(error);
      return errorResult(action.tool, error, logger);
    }
  };

  if (action.class === "R" || action.class === "R+" || action.class === "W") return execute();

  // W+ and X: two-step call with a confirmation token.
  const binding = { tool: action.key, args: action.args, subject: identity.subject };
  if (action.confirmationToken === undefined) {
    let preview: ToolOutput;
    try {
      preview = (await action.preview?.()) ?? {};
    } catch (error) {
      audit("error", { reason: "preview_failed" });
      return errorResult(action.tool, error, logger);
    }
    const issued = runtime.signer.issue(binding);
    audit("confirmation_issued");
    return okResult({
      status: "confirmation_required",
      action: action.summary,
      preview,
      confirmation_token: issued.token,
      expires_at: new Date(issued.expiresAt).toISOString(),
      next_step:
        "Show the preview to the user. Only if they agree, call the tool again with the same " +
        "arguments plus confirmation_token.",
    });
  }

  const verified = runtime.signer.verify(action.confirmationToken, binding);
  if (!verified.ok) {
    audit("denied", { reason: verified.reason });
    return failure(
      `The confirmation_token ${REJECT_TEXT[verified.reason]}. ` +
        "Call the tool again without confirmation_token to get a new preview.",
    );
  }

  if (action.class === "W+") return execute();

  // X: human approval where the client can ask, otherwise only with an
  // explicit operator release.
  if (clientSupportsElicitation(env.server, ctx)) {
    const state = approvalState(ctx);
    if (state === "pending") {
      audit("approval_requested");
      return inputRequired({
        inputRequests: {
          [APPROVAL_KEY]: inputRequired.elicit({
            message: `${action.summary} This cannot be undone. Execute it?`,
            requestedSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "boolean",
                  title: "Execute",
                  description: "Yes, execute this irreversible sevdesk action.",
                },
              },
              required: ["confirm"],
            },
          }),
        },
      });
    }
    if (state === "declined") {
      audit("declined");
      return failure(`The user did not approve ${action.tool}. Nothing was executed.`);
    }
  } else if (!action.explicitlyAllowed) {
    audit("denied", { reason: "no_approval_channel" });
    return failure(
      `${action.tool} is irreversible and this client cannot ask the user for approval ` +
        "(no elicitation support). The operator has to release it explicitly " +
        "(SEVDESK_ENABLE_TOOLS, for sevdesk_api_request SEVDESK_API_ALLOW).",
    );
  }

  // Single use and idempotency are consumed only now, right before the
  // upstream call: consuming them earlier would make the approval round
  // look like a replay.
  const { claims } = verified;
  const nonceTtl = Math.max(1, claims.expiresAt - runtime.now()) + 60_000;
  const idempotencyKey = `idempotency:${action.operationId ?? action.tool}:${
    action.targetId ?? `args:${argumentHash(action.args)}`
  }`;
  try {
    if (!(await runtime.nonces.consume(`nonce:${claims.nonce}`, nonceTtl))) {
      audit("denied", { reason: "replay" });
      return failure(
        "This confirmation_token was already used. Call the tool again without it for a new preview.",
      );
    }
    if (!(await runtime.nonces.consume(idempotencyKey, IDEMPOTENCY_TTL_MS))) {
      audit("denied", { reason: "duplicate" });
      return failure(
        `${action.tool} already ran for this target within the last 24 hours. ` +
          "Check the result in sevdesk; it is not repeated automatically.",
      );
    }
  } catch (error) {
    logger.error("nonce store failed", { tool: action.tool, error });
    audit("denied", { reason: "nonce_store_unavailable" });
    return failure(
      "The replay protection store is unavailable, so the action was not executed. Try again later.",
    );
  }

  return execute(async (error) => {
    if (!isDefiniteRejection(error)) return;
    try {
      await runtime.nonces.release(idempotencyKey);
    } catch (releaseError) {
      logger.warn("could not release idempotency key", { tool: action.tool, error: releaseError });
    }
  });
}
