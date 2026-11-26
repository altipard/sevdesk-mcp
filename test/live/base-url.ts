/**
 * Helpers of the live smoke (test/live/run.mjs), kept in TypeScript so the
 * unit tests can check them; Node 24 runs this file without a build step.
 */

/**
 * Validates SEVDESK_LIVE_BASE_URL. The smoke sends a real token, so only
 * https on sevdesk's own hosts is accepted. Undefined or blank means the
 * default base URL.
 */
export function liveBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("SEVDESK_LIVE_BASE_URL must be an absolute https URL");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !(host === "sevdesk.de" || host.endsWith(".sevdesk.de"))
  ) {
    throw new Error("SEVDESK_LIVE_BASE_URL must be https on sevdesk.de or a subdomain of it");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

const berlin = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date in German time, the zone the sevdesk filters use. */
export function berlinDate(ms: number = Date.now()): string {
  return berlin.format(new Date(ms));
}
