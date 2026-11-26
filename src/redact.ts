export const REDACTED = "[REDACTED]";

export type Redactor = (text: string) => string;

/**
 * Returns a function that replaces every occurrence of the given secrets.
 * Used for anything that may leave the process: log lines, error messages
 * and upstream response text echoed into tool results.
 */
export function createRedactor(secrets: readonly string[]): Redactor {
  const active = secrets.filter((secret) => secret.length > 0);
  if (active.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const secret of active) out = out.replaceAll(secret, REDACTED);
    return out;
  };
}
