import { createRedactor } from "../redact.js";
import type { OperationClass } from "./classification.js";

export type AuditOutcome =
  /** Executed, sevdesk accepted it. */
  | "ok"
  /** Executed or attempted, failed. */
  | "error"
  /** Refused by the policy: rights, allowlist, token, nonce, store. */
  | "denied"
  /** First step of W+/X: preview and confirmation token handed out. */
  | "confirmation_issued"
  /** Human approval asked for (elicitation). */
  | "approval_requested"
  /** The human declined or cancelled the approval. */
  | "declined";

/**
 * One audit event. Deliberately no arguments, bodies or tokens: the event
 * says who did what to which object and how it ended, not with which data.
 */
export interface AuditEvent {
  subject: string;
  tool: string;
  operationId?: string | undefined;
  targetId?: string | undefined;
  class: OperationClass;
  outcome: AuditOutcome;
  /** Short machine-readable reason for denied/error, e.g. "expired". */
  reason?: string | undefined;
  /** HTTP status from sevdesk, if there was a response. */
  status?: number | undefined;
}

export interface AuditLog {
  record(event: AuditEvent): void;
}

export interface AuditLogOptions {
  /** Values that must never appear in output (API token, confirm secret). */
  redact?: readonly string[];
  /** Line sink, stderr by default like the logger. */
  write?: (line: string) => void;
  now?: () => Date;
}

/**
 * Audit events go to their own sink, independent of LOG_LEVEL: an operator
 * running at "error" must still get the trail of every write.
 */
export function createAuditLog(options: AuditLogOptions = {}): AuditLog {
  const redact = createRedactor(options.redact ?? []);
  const write = options.write ?? ((line: string) => void process.stderr.write(line));
  const now = options.now ?? (() => new Date());

  return {
    record(event) {
      // Copy field by field, so nothing a caller attaches by accident
      // (arguments, a token) reaches the log.
      const entry = {
        time: now().toISOString(),
        level: "info",
        msg: "audit",
        audit: true,
        subject: event.subject,
        tool: event.tool,
        operationId: event.operationId,
        targetId: event.targetId,
        class: event.class,
        outcome: event.outcome,
        reason: event.reason,
        status: event.status,
      };
      write(`${redact(JSON.stringify(entry))}\n`);
    },
  };
}

export const silentAuditLog: AuditLog = { record: () => {} };
