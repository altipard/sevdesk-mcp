import { describe, expect, it } from "vitest";
import { endStreamAt } from "../../src/http/app.js";

function endless(onCancel: (reason: unknown) => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: message\ndata: {}\n\n"));
    },
    cancel: onCancel,
  });
}

const sse = (body: ReadableStream<Uint8Array>) =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

async function drain(response: Response): Promise<string> {
  return await response.text();
}

describe("endStreamAt", () => {
  it("ends an event stream at the deadline and cancels the source", async () => {
    let cancelled: unknown;
    const started = Date.now();
    const wrapped = endStreamAt(sse(endless((r) => (cancelled = r))), started + 100);
    const text = await drain(wrapped);
    expect(text).toContain("event: message");
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(cancelled).toBe("access token expired");
    expect(wrapped.headers.get("content-type")).toBe("text/event-stream");
  });

  it("ends at once when the deadline has already passed", async () => {
    const wrapped = endStreamAt(sse(endless(() => {})), Date.now() - 1000);
    expect(await drain(wrapped)).toBe("");
  });

  it("passes a stream that ends by itself through and stops the timer", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: done\n\n"));
        controller.close();
      },
    });
    const wrapped = endStreamAt(sse(body), Date.now() + 60_000);
    expect(await drain(wrapped)).toBe("data: done\n\n");
  });

  it("returns other responses unchanged", () => {
    const json = Response.json({ ok: true });
    expect(endStreamAt(json, 0)).toBe(json);
    const empty = new Response(null, { status: 202 });
    expect(endStreamAt(empty, 0)).toBe(empty);
  });

  it("cancels the source when the client goes away first", async () => {
    let cancelled: unknown;
    const wrapped = endStreamAt(sse(endless((r) => (cancelled = r))), Date.now() + 60_000);
    await wrapped.body?.cancel("client gone");
    expect(cancelled).toBe("client gone");
  });
});
