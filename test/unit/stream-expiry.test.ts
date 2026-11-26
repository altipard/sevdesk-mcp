import { DEFAULT_MAX_REQUEST_BODY_SIZE } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { endStreamAt, HTTP_MAX_REQUEST_BODY_BYTES, isLongLivedStream } from "../../src/http/app.js";

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

describe("isLongLivedStream", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const rpc = (method: string) => ({ jsonrpc: "2.0", id: 1, method, params: {} });

  it("counts the legacy GET stream and subscriptions/listen", async () => {
    expect(await isLongLivedStream(new Request("http://127.0.0.1/mcp"))).toBe(true);
    expect(await isLongLivedStream(post(rpc("subscriptions/listen")))).toBe(true);
    expect(await isLongLivedStream(post([rpc("tools/list"), rpc("subscriptions/listen")]))).toBe(
      true,
    );
  });

  it("does not count tool calls, other methods, broken or oversized bodies", async () => {
    expect(await isLongLivedStream(post(rpc("tools/call")))).toBe(false);
    expect(await isLongLivedStream(post(rpc("tools/list")))).toBe(false);
    expect(await isLongLivedStream(post("{not json"))).toBe(false);
    expect(await isLongLivedStream(post({ method: 42 }))).toBe(false);
    expect(
      await isLongLivedStream(
        post(rpc("subscriptions/listen"), {
          "content-length": String(HTTP_MAX_REQUEST_BODY_BYTES + 1),
        }),
      ),
    ).toBe(false);
    const big = `{"method":"subscriptions/listen","pad":"${"x".repeat(HTTP_MAX_REQUEST_BODY_BYTES)}"}`;
    expect(await isLongLivedStream(post(big))).toBe(false);
    expect(await isLongLivedStream(new Request("http://127.0.0.1/mcp", { method: "DELETE" }))).toBe(
      false,
    );
  });

  it("counts a listen padded past the SDK default, up to the body limit the handler takes", async () => {
    // Otherwise padding would let a subscription escape the cut at token expiry.
    const padded = `{"method":"subscriptions/listen","pad":"${"x".repeat(DEFAULT_MAX_REQUEST_BODY_SIZE)}"}`;
    expect(await isLongLivedStream(post(padded))).toBe(true);
  });

  it("leaves the body readable for the handler", async () => {
    const request = post(rpc("subscriptions/listen"));
    await isLongLivedStream(request);
    expect(await request.json()).toMatchObject({ method: "subscriptions/listen" });
  });
});
