import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSevdeskClient, type SevdeskClientOptions } from "../../src/sevdesk/client.js";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import { createRateLimiterRegistry } from "../../src/sevdesk/rate-limit.js";
import { MOCK_BASE_URL, TEST_TOKEN } from "../helpers.js";

// Pacing and 429 retries with a fake fetch and a fake clock: nothing here
// touches the network or waits in real time.

interface Seen {
  method: string;
  path: string;
  body: string;
  at: number;
}

type Answer = Response | (() => Response) | Error;

let clock: number;
let seen: Seen[];
let answers: Answer[];
let clientWaits: number[];
let limiterWaits: number[];

const json = (status: number, headers: Record<string, string> = {}, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

beforeEach(() => {
  clock = 0;
  seen = [];
  answers = [];
  clientWaits = [];
  limiterWaits = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    seen.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: await request.text(),
      at: clock,
    });
    const answer = answers.shift() ?? json(200, {}, { objects: [] });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer() : answer;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const now = () => clock;

function registry() {
  return createRateLimiterRegistry({
    now,
    sleep: async (ms) => {
      limiterWaits.push(ms);
      clock += ms;
    },
  });
}

function setup(options: Partial<SevdeskClientOptions> = {}) {
  return createSevdeskClient({
    baseUrl: MOCK_BASE_URL,
    token: TEST_TOKEN,
    now,
    sleep: async (ms) => {
      clientWaits.push(ms);
      clock += ms;
    },
    rateLimiters: registry(),
    ...options,
  });
}

async function captureError(promise: Promise<unknown>): Promise<SevdeskError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SevdeskError);
    return error as SevdeskError;
  }
  throw new Error("expected a SevdeskError");
}

describe("client-side pacing", () => {
  it("paces every request of a client after the burst", async () => {
    const client = setup({ rateLimit: 2 });
    for (let i = 0; i < 4; i++) await client.call(client.api.GET("/Part"));
    expect(seen.map((s) => s.at)).toEqual([0, 0, 500, 1000]);
    expect(clientWaits).toEqual([]);
  });

  it("is off without a rate", async () => {
    const client = setup();
    for (let i = 0; i < 20; i++) await client.call(client.api.GET("/Part"));
    expect(limiterWaits).toEqual([]);
    expect(seen).toHaveLength(20);
  });

  it("is off at rate 0", async () => {
    const client = setup({ rateLimit: 0 });
    for (let i = 0; i < 20; i++) await client.call(client.api.GET("/Part"));
    expect(limiterWaits).toEqual([]);
  });

  it("shares the bucket between clients of one token, not across tokens", async () => {
    const shared = registry();
    const one = setup({ rateLimit: 1, rateLimiters: shared });
    const two = setup({ rateLimit: 1, rateLimiters: shared });
    const other = setup({ rateLimit: 1, rateLimiters: shared, token: "f".repeat(32) });

    await one.call(one.api.GET("/Part"));
    await other.call(other.api.GET("/Part"));
    expect(limiterWaits).toEqual([]);
    await two.call(two.api.GET("/Part"));
    expect(limiterWaits).toEqual([1000]);
  });

  it("paces retries too", async () => {
    answers = [json(429, { "Retry-After": "0" }), json(200)];
    const client = setup({ rateLimit: 1, retry: { baseDelayMs: 100 } });
    await client.call(client.api.GET("/Part"));
    // 100 ms minimal Retry-After pause, then 900 ms until the next slot.
    expect(clientWaits).toEqual([100]);
    expect(limiterWaits).toEqual([900]);
    expect(seen.map((s) => s.at)).toEqual([0, 1000]);
  });

  it("fails without sending when the pacing wait would pass the deadline", async () => {
    const client = setup({ rateLimit: 0.1, deadlineMs: 5000, timeoutMs: 1000 });
    await client.call(client.api.GET("/Part"));

    const error = await captureError(
      client.call(client.api.POST("/Contact", { body: {} as never })),
    );

    expect(error.kind).toBe("timeout");
    expect(error.message).toBe(
      "The client-side rate limit (SEVDESK_RATE_LIMIT) would hold this request past the 5000 ms deadline. Nothing was sent.",
    );
    expect(seen).toHaveLength(1);
    expect(limiterWaits).toEqual([]);
  });

  it("passes the last 429 on when pacing leaves no room for its retry", async () => {
    answers = [json(429, { "Retry-After": "1" })];
    const client = setup({ rateLimit: 0.2, deadlineMs: 4000, timeoutMs: 1000 });

    const error = await captureError(client.call(client.api.GET("/Part")));

    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("stops waiting for a slot when the caller aborts", async () => {
    const controller = new AbortController();
    const client = setup({
      rateLimit: 1,
      rateLimiters: createRateLimiterRegistry({
        now,
        sleep: () => {
          controller.abort();
          return new Promise(() => {});
        },
      }),
    });
    await client.call(client.api.GET("/Part"));

    await expect(
      client.call(client.api.GET("/Part", { signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toHaveLength(1);
  });
});

describe("retries on 429", () => {
  it("retries a POST after Retry-After and sends the same body again", async () => {
    answers = [json(429, { "Retry-After": "2" }), json(201, {}, { objects: { id: "7" } })];
    const client = setup();

    const data = await client.call(
      client.api.POST("/Contact", { body: { name: "ACME" } as never }),
    );

    expect(data).toEqual({ objects: { id: "7" } });
    expect(clientWaits).toEqual([2000]);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.body).toBe(seen[0]?.body);
    expect(JSON.parse(seen[1]?.body ?? "")).toEqual({ name: "ACME" });
  });

  it.each(["PUT", "DELETE"] as const)("retries a %s answered with 429", async (method) => {
    answers = [json(429), json(200)];
    const client = setup({ retry: { baseDelayMs: 100 } });
    const params = { path: { contactId: 1 } };
    if (method === "PUT") {
      await client.call(client.api.PUT("/Contact/{contactId}", { params, body: {} as never }));
    } else {
      await client.call(client.api.DELETE("/Contact/{contactId}", { params }));
    }

    expect(seen.map((s) => s.method)).toEqual([method, method]);
  });

  it("uses jittered backoff without Retry-After", async () => {
    answers = [json(429), json(429), json(200)];
    const client = setup({ retry: { baseDelayMs: 200 } });

    await client.call(client.api.POST("/Contact", { body: {} as never }));

    expect(clientWaits).toHaveLength(2);
    expect(clientWaits[0]).toBeGreaterThanOrEqual(100);
    expect(clientWaits[0]).toBeLessThanOrEqual(200);
    expect(clientWaits[1]).toBeGreaterThanOrEqual(200);
    expect(clientWaits[1]).toBeLessThanOrEqual(400);
  });

  it("does not wait for a Retry-After above maxDelayMs and passes the hint on", async () => {
    answers = [json(429, { "Retry-After": "11" })];
    const client = setup({ retry: { maxDelayMs: 10_000 } });

    const error = await captureError(
      client.call(client.api.POST("/Contact", { body: {} as never })),
    );

    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(11);
    expect(seen).toHaveLength(1);
    expect(clientWaits).toEqual([]);
  });

  it("gives up after maxRateLimitRetries", async () => {
    answers = Array.from({ length: 10 }, () => () => json(429, { "Retry-After": "1" }));
    const client = setup({ retry: { maxRateLimitRetries: 2 } });

    const error = await captureError(
      client.call(client.api.POST("/Contact", { body: {} as never })),
    );

    expect(error.kind).toBe("rate_limited");
    expect(error.message).toBe("sevdesk rate limit reached (429). Retry in 1 s.");
    expect(seen).toHaveLength(3);
    expect(clientWaits).toEqual([1000, 1000]);
  });

  it("retries 429 independently of maxRetries", async () => {
    answers = [json(429), json(200)];
    const client = setup({ retry: { maxRetries: 0, baseDelayMs: 100 } });
    await client.call(client.api.GET("/Part"));
    expect(seen).toHaveLength(2);
  });

  it("retries 429 through the single-attempt client, but not a 503", async () => {
    answers = [json(429), json(200)];
    const client = setup({ retry: { baseDelayMs: 100 } });
    await client.call(client.apiSingleAttempt.GET("/Part"));
    expect(seen).toHaveLength(2);

    seen = [];
    answers = [json(503), json(200)];
    const error = await captureError(client.call(client.apiSingleAttempt.GET("/Part")));
    expect(error.kind).toBe("server_error");
    expect(seen).toHaveLength(1);
  });

  it("does not retry a 429 when the wait would pass the deadline", async () => {
    answers = [json(429, { "Retry-After": "5" })];
    const client = setup({ deadlineMs: 5500, timeoutMs: 1000 });

    const error = await captureError(
      client.call(client.api.POST("/Contact", { body: {} as never })),
    );

    expect(error.kind).toBe("rate_limited");
    expect(seen).toHaveLength(1);
  });

  it("stops at once when the caller aborts during the 429 wait", async () => {
    answers = [json(429, { "Retry-After": "3" })];
    const controller = new AbortController();
    const client = setup({
      sleep: () => {
        controller.abort();
        return new Promise(() => {});
      },
    });

    await expect(
      client.call(client.api.POST("/Contact", { body: {} as never, signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toHaveLength(1);
  });
});

describe("429 budget and the shared bucket", () => {
  it("gives a 429 its own retries after 5xx retries of a GET", async () => {
    answers = [json(503), json(503), json(429), json(429), json(429), json(200, {}, { ok: 1 })];
    const client = setup({ retry: { baseDelayMs: 100 } });
    await expect(client.call(client.api.GET("/Part"))).resolves.toEqual({ ok: 1 });
    expect(seen).toHaveLength(6);
  });

  it("bounds a mix of 5xx and 429 by both budgets", async () => {
    answers = Array.from({ length: 20 }, (_, i) => () => json(i % 2 === 0 ? 503 : 429));
    const client = setup({
      retry: { maxRetries: 2, maxRateLimitRetries: 2, baseDelayMs: 10 },
    });
    await captureError(client.call(client.api.GET("/Part")));
    expect(seen).toHaveLength(5);
  });

  it("holds back other calls of the token after a 429 with Retry-After", async () => {
    const shared = registry();
    const one = setup({ rateLimit: 4, rateLimiters: shared, retry: { maxRateLimitRetries: 0 } });
    const two = setup({ rateLimit: 4, rateLimiters: shared });
    const other = setup({ rateLimit: 4, rateLimiters: shared, token: "f".repeat(32) });
    answers = [json(429, { "Retry-After": "2" })];

    await captureError(one.call(one.api.POST("/Contact", { body: {} as never })));
    await other.call(other.api.GET("/Part"));
    expect(limiterWaits).toEqual([]);
    await two.call(two.api.GET("/Part"));
    expect(limiterWaits).toEqual([2000]);
  });

  it("caps the hold at maxDelayMs for a huge Retry-After", async () => {
    const client = setup({ rateLimit: 4, deadlineMs: 60_000 });
    answers = [json(429, { "Retry-After": "120" })];
    await captureError(client.call(client.api.GET("/Part")));
    await client.call(client.api.GET("/Part"));
    expect(limiterWaits).toEqual([10_000]);
  });

  it("holds back the token for the minimal pause after a 429 with Retry-After 0", async () => {
    const client = setup({ rateLimit: 4, retry: { maxRateLimitRetries: 0, baseDelayMs: 400 } });
    answers = [json(429, { "Retry-After": "0" })];
    await captureError(client.call(client.api.GET("/Part")));
    await client.call(client.api.GET("/Part"));
    expect(limiterWaits).toEqual([400]);
  });

  it("holds back the token for the backoff after a 429 without Retry-After", async () => {
    const client = setup({ rateLimit: 4, retry: { maxRateLimitRetries: 0, baseDelayMs: 400 } });
    answers = [json(429)];
    await captureError(client.call(client.api.GET("/Part")));
    await client.call(client.api.GET("/Part"));
    // Jittered first backoff: 50 % to 100 % of baseDelayMs.
    expect(limiterWaits).toHaveLength(1);
    expect(limiterWaits[0]).toBeGreaterThanOrEqual(200);
    expect(limiterWaits[0]).toBeLessThanOrEqual(400);
  });
});

describe("retrying uploads on 429", () => {
  it("sends a FormData file upload again in full", async () => {
    answers = [json(429, { "Retry-After": "1" }), json(201, {}, { objects: [{ filename: "x" }] })];
    const client = setup();
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array([37, 80, 68, 70, 1, 2, 3])], { type: "application/pdf" }),
      "beleg.pdf",
    );

    await client.call(
      client.api.POST("/Voucher/Factory/uploadTempFile", {
        body: form as never,
        bodySerializer: (body: unknown) => body as FormData,
      }),
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]?.body).toContain('filename="beleg.pdf"');
    expect(seen[0]?.body).toContain("%PDF");
    expect(seen[1]?.body).toBe(seen[0]?.body);
  });

  it("sends a streamed body again in full", async () => {
    answers = [json(429, { "Retry-After": "1" }), json(201)];
    const client = setup();
    const chunks = ["first ", "second"];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
    });

    await client.call(
      client.api.POST("/Contact", {
        body: stream as never,
        // fetch needs duplex for a stream body; openapi-fetch passes it on.
        duplex: "half",
        bodySerializer: (body: unknown) => body as ReadableStream,
      }),
    );

    expect(seen.map((s) => s.body)).toEqual(["first second", "first second"]);
  });
});

describe("writes stay single-shot on everything but 429", () => {
  it.each([500, 502, 503, 504])("sends a POST answered with %i once", async (status) => {
    answers = [json(status), json(200)];
    const client = setup();

    const error = await captureError(
      client.call(client.api.POST("/Contact", { body: {} as never })),
    );

    expect(error.kind).toBe("server_error");
    expect(error.message).toContain("The outcome is unknown");
    expect(seen).toHaveLength(1);
  });

  it("sends a PUT that hits a network error once", async () => {
    answers = [new TypeError("fetch failed"), json(200)];
    const client = setup();

    const error = await captureError(
      client.call(
        client.api.PUT("/Contact/{contactId}", {
          params: { path: { contactId: 1 } },
          body: {} as never,
        }),
      ),
    );

    expect(error.kind).toBe("network");
    expect(seen).toHaveLength(1);
  });

  it("does not retry a write after a 503 that followed a 429", async () => {
    answers = [json(429), json(503), json(200)];
    const client = setup({ retry: { baseDelayMs: 100 } });

    const error = await captureError(
      client.call(client.api.POST("/Contact", { body: {} as never })),
    );

    expect(error.kind).toBe("server_error");
    expect(seen).toHaveLength(2);
  });
});
