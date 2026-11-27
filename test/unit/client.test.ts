import { delay, HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logger.js";
import {
  createSevdeskClient,
  type RequestGate,
  restrictClient,
  type SevdeskClientOptions,
} from "../../src/sevdesk/client.js";
import { SevdeskError, type SevdeskErrorKind } from "../../src/sevdesk/errors.js";
import { USER_AGENT } from "../../src/version.js";
import { captureLogger, errorRepresentations, MOCK_BASE_URL, TEST_TOKEN } from "../helpers.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const url = (path: string) => `${MOCK_BASE_URL}${path}`;

function setup(options: Partial<SevdeskClientOptions> = {}) {
  const { logger, lines } = captureLogger();
  const sleeps: number[] = [];
  const client = createSevdeskClient({
    baseUrl: MOCK_BASE_URL,
    token: TEST_TOKEN,
    logger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { client, sleeps, logLines: lines };
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

describe("sevdesk client requests", () => {
  it("sends the raw token, the User-Agent and declared query parameters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(url("/Contact"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ objects: [] });
      }),
    );
    const { client } = setup();

    // Typed call: limit/offset/countAll/embed only exist through openapi/overlay.yaml,
    // so typecheck fails if the overlay stops applying.
    const data = await client.call(
      client.api.GET("/Contact", {
        params: { query: { limit: 10, offset: 20, countAll: true, embed: "parentId" } },
      }),
    );

    expect(data).toEqual({ objects: [] });
    expect(seen?.headers.get("authorization")).toBe(TEST_TOKEN);
    expect(seen?.headers.get("user-agent")).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^sevdesk-mcp\/\d+\.\d+\.\d+/);
    const query = new URL(seen?.url ?? "").searchParams;
    expect(Object.fromEntries(query)).toEqual({
      limit: "10",
      offset: "20",
      countAll: "true",
      embed: "parentId",
    });
  });

  it("tolerates a trailing slash in the base URL", async () => {
    server.use(http.get(url("/CheckAccount"), () => HttpResponse.json({ objects: [] })));
    const { client } = setup({ baseUrl: `${MOCK_BASE_URL}/` });
    await expect(client.call(client.api.GET("/CheckAccount"))).resolves.toEqual({ objects: [] });
  });
});

describe("error mapping", () => {
  it.each<[number, SevdeskErrorKind, string]>([
    [400, "bad_request", "sevdesk rejected the request (400): Invalid filter"],
    [401, "unauthorized", "Check SEVDESK_API_TOKEN"],
    [403, "forbidden", "not allowed to do this (403): Invalid filter"],
    [404, "not_found", "does not exist (404): Invalid filter"],
    [422, "validation", "could not process the data (422): Invalid filter"],
    [429, "rate_limited", "rate limit reached (429)"],
    [500, "server_error", "sevdesk server error (500): Invalid filter"],
    [503, "server_error", "sevdesk server error (503)"],
    [418, "http_error", "Unexpected sevdesk response (418)"],
  ])("maps %i to %s", async (status, kind, message) => {
    server.use(
      http.get(url("/Part"), () =>
        HttpResponse.json(
          { error: { message: "Invalid filter", exceptionUUID: "abc-123" } },
          { status },
        ),
      ),
    );
    const { client } = setup({ retry: { maxRetries: 0 } });

    const error = await captureError(client.call(client.api.GET("/Part")));

    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.exceptionUUID).toBe("abc-123");
    expect(error.message).toContain(message);
  });

  it("passes the Retry-After hint of a 429 on", async () => {
    server.use(
      http.post(url("/Contact"), () =>
        HttpResponse.json({}, { status: 429, headers: { "Retry-After": "7" } }),
      ),
    );
    const { client } = setup();

    const error = await captureError(
      client.call(client.api.POST("/Contact", { body: {} as never })),
    );

    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(7);
    expect(error.message).toContain("Retry in 7 s.");
  });

  it("uses a plain-text error body as detail", async () => {
    server.use(
      http.get(url("/Part"), () => new HttpResponse("upstream exploded", { status: 400 })),
    );
    const { client } = setup();
    const error = await captureError(client.call(client.api.GET("/Part")));
    expect(error.message).toBe("sevdesk rejected the request (400): upstream exploded");
  });

  it("maps a timeout", async () => {
    server.use(
      http.get(url("/Part"), async () => {
        await delay(500);
        return HttpResponse.json({ objects: [] });
      }),
    );
    const { client } = setup({ timeoutMs: 20, retry: { maxRetries: 0 } });
    const error = await captureError(client.call(client.api.GET("/Part")));
    expect(error.kind).toBe("timeout");
    expect(error.message).toBe("sevdesk did not answer within 20 ms.");
  });

  it("maps a successful response that is not JSON", async () => {
    server.use(
      http.get(
        url("/Part"),
        () =>
          new HttpResponse("<html>maintenance</html>", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { client } = setup();
    const error = await captureError(client.call(client.api.GET("/Part")));
    expect(error.kind).toBe("http_error");
    expect(error.message).toBe("sevdesk sent a response that is not valid JSON.");
  });

  it("maps a network failure", async () => {
    server.use(http.get(url("/Part"), () => HttpResponse.error()));
    const { client } = setup({ retry: { maxRetries: 0 } });
    const error = await captureError(client.call(client.api.GET("/Part")));
    expect(error.kind).toBe("network");
  });
});

describe("retries", () => {
  it("retries GET on 5xx and 429 with backoff, then succeeds", async () => {
    const statuses = [503, 429, 200];
    let calls = 0;
    server.use(
      http.get(url("/Voucher"), () => {
        const status = statuses[calls++] ?? 200;
        return status === 200
          ? HttpResponse.json({ objects: [{ id: "1" }] })
          : HttpResponse.json(
              {},
              { status, headers: status === 429 ? { "Retry-After": "2" } : {} },
            );
      }),
    );
    const { client, sleeps } = setup({ retry: { baseDelayMs: 100 } });

    const data = await client.call(client.api.GET("/Voucher"));

    expect(data).toEqual({ objects: [{ id: "1" }] });
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(50);
    expect(sleeps[0]).toBeLessThanOrEqual(100);
    expect(sleeps[1]).toBe(2000);
  });

  it("retries GET on network errors", async () => {
    let calls = 0;
    server.use(
      http.get(url("/Voucher"), () =>
        calls++ === 0 ? HttpResponse.error() : HttpResponse.json({ objects: [] }),
      ),
    );
    const { client } = setup();
    await expect(client.call(client.api.GET("/Voucher"))).resolves.toEqual({ objects: [] });
    expect(calls).toBe(2);
  });

  it.each([
    ["0", 100],
    ["Thu, 01 Jan 1970 00:00:00 GMT", 100],
  ])("waits at least baseDelayMs for Retry-After %j", async (retryAfter, expected) => {
    let calls = 0;
    server.use(
      http.get(url("/Voucher"), () =>
        calls++ === 0
          ? HttpResponse.json({}, { status: 429, headers: { "Retry-After": retryAfter } })
          : HttpResponse.json({ objects: [] }),
      ),
    );
    const { client, sleeps } = setup({ retry: { baseDelayMs: 100 } });

    await client.call(client.api.GET("/Voucher"));

    expect(sleeps).toEqual([expected]);
  });

  it("falls back to backoff for an unparsable Retry-After", async () => {
    let calls = 0;
    server.use(
      http.get(url("/Voucher"), () =>
        calls++ === 0
          ? HttpResponse.json({}, { status: 429, headers: { "Retry-After": "1.5" } })
          : HttpResponse.json({ objects: [] }),
      ),
    );
    const { client, sleeps } = setup({ retry: { baseDelayMs: 100 } });

    await client.call(client.api.GET("/Voucher"));

    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(50);
    expect(sleeps[0]).toBeLessThanOrEqual(100);
  });

  it("gives up after maxRetries", async () => {
    let calls = 0;
    server.use(
      http.get(url("/Voucher"), () => {
        calls++;
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    const { client, sleeps } = setup({ retry: { maxRetries: 2 } });

    const error = await captureError(client.call(client.api.GET("/Voucher")));

    expect(error.kind).toBe("server_error");
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it.each([500, 501, 505])("does not retry a GET answered with %i", async (status) => {
    let calls = 0;
    server.use(
      http.get(url("/Voucher"), () => {
        calls++;
        return HttpResponse.json({}, { status });
      }),
    );
    const { client, sleeps } = setup();

    const error = await captureError(client.call(client.api.GET("/Voucher")));

    expect(error.kind).toBe("server_error");
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it.each([502, 504])("retries a GET answered with %i", async (status) => {
    let calls = 0;
    server.use(
      http.get(url("/Voucher"), () =>
        calls++ === 0 ? HttpResponse.json({}, { status }) : HttpResponse.json({ objects: [] }),
      ),
    );
    const { client } = setup();
    await expect(client.call(client.api.GET("/Voucher"))).resolves.toEqual({ objects: [] });
    expect(calls).toBe(2);
  });

  it("caps exponential backoff at maxDelayMs", async () => {
    server.use(http.get(url("/Voucher"), () => HttpResponse.json({}, { status: 503 })));
    const { client, sleeps } = setup({
      retry: { maxRetries: 5, baseDelayMs: 100, maxDelayMs: 250 },
    });

    await captureError(client.call(client.api.GET("/Voucher")));

    expect(sleeps).toHaveLength(5);
    for (const ms of sleeps) expect(ms).toBeLessThanOrEqual(250);
    // From the third attempt on 100 * 2^n exceeds the cap, so only jitter remains.
    for (const ms of sleeps.slice(2)) expect(ms).toBeGreaterThanOrEqual(125);
  });

  it("waits until the HTTP date given in Retry-After", async () => {
    let calls = 0;
    const retryAt = new Date(Date.now() + 5000).toUTCString();
    server.use(
      http.get(url("/Voucher"), () =>
        calls++ === 0
          ? HttpResponse.json({}, { status: 503, headers: { "Retry-After": retryAt } })
          : HttpResponse.json({ objects: [] }),
      ),
    );
    const { client, sleeps } = setup();

    await client.call(client.api.GET("/Voucher"));

    expect(sleeps).toHaveLength(1);
    // HTTP dates have second resolution.
    expect(sleeps[0]).toBeGreaterThan(3000);
    expect(sleeps[0]).toBeLessThanOrEqual(5000);
  });

  it("does not wait for a Retry-After longer than maxDelayMs", async () => {
    let calls = 0;
    server.use(
      http.get(url("/Voucher"), () => {
        calls++;
        return HttpResponse.json({}, { status: 429, headers: { "Retry-After": "120" } });
      }),
    );
    const { client, sleeps } = setup();

    const error = await captureError(client.call(client.api.GET("/Voucher")));

    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(error.retryAfterSeconds).toBe(120);
  });

  it.each([500, 503])("sends a POST answered with %i exactly once", async (status) => {
    let calls = 0;
    server.use(
      http.post(url("/Contact"), () => {
        calls++;
        return HttpResponse.json({}, { status });
      }),
    );
    const { client, sleeps } = setup();

    await captureError(client.call(client.api.POST("/Contact", { body: {} as never })));

    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("sends a PUT that fails on the network exactly once", async () => {
    let calls = 0;
    server.use(
      http.put(url("/Contact/:id"), () => {
        calls++;
        return HttpResponse.error();
      }),
    );
    const { client } = setup();

    const error = await captureError(
      client.call(
        client.api.PUT("/Contact/{contactId}", {
          params: { path: { contactId: 1 } },
          body: {} as never,
        }),
      ),
    );

    expect(error.kind).toBe("network");
    expect(calls).toBe(1);
  });
});

describe("token never leaks", () => {
  it.each([400, 401, 403, 404, 422, 500])(
    "keeps the token out of errors and logs when a %i body echoes it",
    async (status) => {
      server.use(
        http.get(url("/Invoice"), () =>
          HttpResponse.json(
            {
              error: {
                message: `Token ${TEST_TOKEN} is not valid`,
                exceptionUUID: TEST_TOKEN,
              },
            },
            { status },
          ),
        ),
      );
      const { client, logLines } = setup({ retry: { maxRetries: 1 } });

      const error = await captureError(client.call(client.api.GET("/Invoice")));

      expect(errorRepresentations(error)).not.toContain(TEST_TOKEN);
      expect(logLines.join("")).not.toContain(TEST_TOKEN);
      expect(logLines.length).toBeGreaterThan(0);
    },
  );

  it("keeps the token out of network errors", async () => {
    server.use(http.get(url("/Invoice"), () => HttpResponse.error()));
    const { client, logLines } = setup({ retry: { maxRetries: 1 } });

    const error = await captureError(client.call(client.api.GET("/Invoice")));

    expect(error.kind).toBe("network");
    expect(errorRepresentations(error)).not.toContain(TEST_TOKEN);
    expect(logLines.join("")).not.toContain(TEST_TOKEN);
  });

  it("keeps the token out of timeout errors", async () => {
    server.use(
      http.get(url("/Invoice"), async () => {
        await delay(500);
        return HttpResponse.json({ objects: [] });
      }),
    );
    const { client, logLines } = setup({ timeoutMs: 20, retry: { maxRetries: 1 } });

    const error = await captureError(client.call(client.api.GET("/Invoice")));

    expect(error.kind).toBe("timeout");
    expect(errorRepresentations(error)).not.toContain(TEST_TOKEN);
    expect(logLines.join("")).not.toContain(TEST_TOKEN);
  });
});

describe("timeouts and deadline", () => {
  it("retries a GET that timed out before the headers", async () => {
    let calls = 0;
    server.use(
      http.get(url("/Part"), async () => {
        if (calls++ === 0) await delay(500);
        return HttpResponse.json({ objects: [] });
      }),
    );
    const { client, sleeps } = setup({ timeoutMs: 30 });

    await expect(client.call(client.api.GET("/Part"))).resolves.toEqual({ objects: [] });
    expect(calls).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it("stops retrying when the next wait would pass the deadline", async () => {
    let clock = 0;
    let calls = 0;
    const waits: number[] = [];
    server.use(
      http.get(url("/Voucher"), () => {
        calls++;
        return HttpResponse.json({}, { status: 503, headers: { "Retry-After": "0" } });
      }),
    );
    const { client } = setup({
      timeoutMs: 100,
      deadlineMs: 1000,
      retry: { maxRetries: 10, baseDelayMs: 300 },
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });

    const error = await captureError(client.call(client.api.GET("/Voucher")));

    expect(error.kind).toBe("server_error");
    expect(waits).toEqual([300, 300, 300]);
    expect(calls).toBe(4);
  });

  it("shortens the attempt timeout to the remaining deadline", async () => {
    server.use(
      http.get(url("/Part"), async () => {
        await delay(500);
        return HttpResponse.json({ objects: [] });
      }),
    );
    const { client } = setup({
      timeoutMs: 10_000,
      deadlineMs: 40,
      retry: { maxRetries: 0 },
      now: () => 0,
    });

    const error = await captureError(client.call(client.api.GET("/Part")));

    expect(error.kind).toBe("timeout");
    expect(error.message).toBe("sevdesk did not answer within 40 ms.");
  });

  it("does not start a retry that would only get a sliver of the deadline", async () => {
    let clock = 0;
    let calls = 0;
    server.use(
      http.get(url("/Part"), async () => {
        calls++;
        await delay(500);
        return HttpResponse.json({ objects: [] });
      }),
    );
    const { client, sleeps } = setup({
      timeoutMs: 20,
      deadlineMs: 1000,
      retry: { maxRetries: 5, baseDelayMs: 600, maxDelayMs: 600 },
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });

    // No jitter: every wait is exactly 600 ms.
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    const error = await captureError(client.call(client.api.GET("/Part"))).finally(() =>
      random.mockRestore(),
    );

    // 600 ms wait + 20 ms attempt fit into 1000 ms once; a second wait would
    // leave less than one attempt, so the client stops and names the deadline.
    expect(error.kind).toBe("timeout");
    expect(error.message).toBe("sevdesk did not answer within the 1000 ms deadline.");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([600]);
  });

  it("names the deadline for a network failure it stopped retrying", async () => {
    server.use(http.get(url("/Part"), () => HttpResponse.error()));
    const { client } = setup({ timeoutMs: 5000, deadlineMs: 500, now: () => 0 });

    const error = await captureError(client.call(client.api.GET("/Part")));

    expect(error.kind).toBe("network");
    expect(error.message).toBe("Could not reach sevdesk. Gave up within the 500 ms deadline.");
  });

  it("warns that a write that timed out may have happened", async () => {
    let calls = 0;
    server.use(
      http.post(url("/Contact"), async () => {
        calls++;
        await delay(500);
        return HttpResponse.json({ objects: {} });
      }),
    );
    const { client } = setup({ timeoutMs: 20 });

    const error = await captureError(
      client.call(client.api.POST("/Contact", { body: {} as never })),
    );

    expect(error.kind).toBe("timeout");
    expect(error.message).toBe(
      "sevdesk did not answer within 20 ms. The outcome is unknown: check sevdesk before retrying.",
    );
    expect(calls).toBe(1);
  });

  it("warns that a write that hit a network error may have happened", async () => {
    server.use(http.put(url("/Contact/:id"), () => HttpResponse.error()));
    const { client } = setup();

    const error = await captureError(
      client.call(
        client.api.PUT("/Contact/{contactId}", {
          params: { path: { contactId: 1 } },
          body: {} as never,
        }),
      ),
    );

    expect(error.kind).toBe("network");
    expect(error.message).toBe(
      "Could not reach sevdesk. The outcome is unknown: check sevdesk before retrying.",
    );
  });

  it("never retries through the single-attempt client, also for GET", async () => {
    let calls = 0;
    server.use(
      http.get(url("/Part"), () => {
        calls++;
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    const { client, sleeps } = setup();

    const error = await captureError(client.call(client.apiSingleAttempt.GET("/Part")));

    expect(error.kind).toBe("server_error");
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("warns about an unknown outcome when a write gets a server error", async () => {
    server.use(
      http.post(url("/Contact"), () => HttpResponse.json({}, { status: 503 })),
      http.get(url("/Contact"), () => HttpResponse.json({}, { status: 503 })),
    );
    const { client } = setup({ retry: { maxRetries: 0 } });

    const write = await captureError(
      client.call(client.api.POST("/Contact", { body: {} as never })),
    );
    expect(write.message).toBe(
      "sevdesk server error (503) The outcome is unknown: check sevdesk before retrying.",
    );

    const read = await captureError(client.call(client.api.GET("/Contact")));
    expect(read.message).toBe("sevdesk server error (503)");
  });

  it("warns about an unknown outcome for single-attempt GETs", async () => {
    server.use(
      http.get(url("/Part"), () => HttpResponse.json({}, { status: 502 })),
      http.get(url("/Voucher"), async () => {
        await delay(500);
        return HttpResponse.json({});
      }),
    );
    const { client } = setup({ timeoutMs: 20 });

    const status = await captureError(client.call(client.apiSingleAttempt.GET("/Part")));
    expect(status.message).toBe(
      "sevdesk server error (502) The outcome is unknown: check sevdesk before retrying.",
    );
    const timeout = await captureError(client.call(client.apiSingleAttempt.GET("/Voucher")));
    expect(timeout.message).toBe(
      "sevdesk did not answer within 20 ms. The outcome is unknown: check sevdesk before retrying.",
    );
  });

  it("drops a response whose declared size exceeds the byte limit, without retrying", async () => {
    let calls = 0;
    server.use(
      http.get(url("/Contact"), () => {
        calls++;
        return HttpResponse.json({ objects: [{ name: "x".repeat(2000) }] });
      }),
    );
    const { client, sleeps } = setup({ maxResponseBytes: 1000 });

    const error = await captureError(client.call(client.api.GET("/Contact")));

    expect(error.kind).toBe("response_too_large");
    expect(error.message).toBe(
      "sevdesk sent more than 1000 bytes; the response was dropped. Narrow the request.",
    );
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("warns of an unknown outcome when a write's oversized answer was not a refusal", async () => {
    const big = { objects: { name: "x".repeat(2000) } };
    server.use(
      http.post(url("/Contact"), () => HttpResponse.json(big, { status: 201 })),
      http.put(url("/Contact/:id"), () => HttpResponse.json(big, { status: 422 })),
      http.get(url("/Voucher"), () => HttpResponse.json(big)),
    );
    const { client } = setup({ maxResponseBytes: 1000 });

    const created = await captureError(
      client.call(client.api.POST("/Contact", { body: { name: "A" } as never })),
    );
    expect(created.kind).toBe("response_too_large");
    expect(created.status).toBe(201);
    expect(created.message).toBe(
      "sevdesk sent more than 1000 bytes; the response was dropped. Narrow the request. " +
        "The outcome is unknown: check sevdesk before retrying.",
    );

    const refused = await captureError(
      client.call(
        client.api.PUT("/Contact/{contactId}", {
          params: { path: { contactId: 1 } },
          body: {} as never,
        }),
      ),
    );
    expect(refused.message).not.toContain("outcome is unknown");

    const sideEffectGet = await captureError(client.call(client.apiSingleAttempt.GET("/Voucher")));
    expect(sideEffectGet.message).toContain("The outcome is unknown");
    const plainGet = await captureError(client.call(client.api.GET("/Voucher")));
    expect(plainGet.message).not.toContain("outcome is unknown");
  });

  it("accepts a response within the byte limit", async () => {
    server.use(http.get(url("/Tag"), () => HttpResponse.json({ objects: [] })));
    const { client } = setup({ maxResponseBytes: 1000 });
    await expect(client.call(client.api.GET("/Tag"))).resolves.toEqual({ objects: [] });
  });

  it("passes a 204 through without a body", async () => {
    server.use(http.delete(url("/Contact/:id"), () => new HttpResponse(null, { status: 204 })));
    const { client } = setup();

    await expect(
      client.call(
        client.api.DELETE("/Contact/{contactId}", { params: { path: { contactId: 1 } } }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("aborting during a retry wait", () => {
  const retryAfter503 = (seconds: string) => {
    let calls = 0;
    server.use(
      http.get(url("/Voucher"), () => {
        calls++;
        return HttpResponse.json({}, { status: 503, headers: { "Retry-After": seconds } });
      }),
    );
    return () => calls;
  };

  it("ends a real Retry-After wait shortly before the deadline at once", async () => {
    // The 5 s wait just fits the 6.1 s deadline, so the client would sleep.
    const calls = retryAfter503("5");
    const client = createSevdeskClient({
      baseUrl: MOCK_BASE_URL,
      token: TEST_TOKEN,
      timeoutMs: 1000,
      deadlineMs: 6100,
    });
    const controller = new AbortController();
    const started = Date.now();
    const pending = client.call(client.api.GET("/Voucher", { signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(calls()).toBe(1);
  });

  it("hands the caller's signal to the sleep and stops waiting when it aborts", async () => {
    const calls = retryAfter503("1");
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const { client } = setup({
      sleep: (_ms, signal) => {
        signals.push(signal);
        controller.abort();
        return new Promise(() => {});
      },
    });

    await expect(
      client.call(client.api.GET("/Voucher", { signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(calls()).toBe(1);
  });

  it("does not start the wait when the caller aborted before it", async () => {
    const calls = retryAfter503("1");
    const controller = new AbortController();
    // The retry warning is logged right before the wait; abort there.
    const logger = createLogger({
      level: "debug",
      redact: [TEST_TOKEN],
      write: (line) => {
        if (line.includes("retrying")) controller.abort();
      },
    });
    const { client, sleeps } = setup({ logger });

    await expect(
      client.call(client.api.GET("/Voucher", { signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(sleeps).toEqual([]);
    expect(calls()).toBe(1);
  });
});

describe("what reaches the network", () => {
  afterEach(() => {
    server.events.removeAllListeners("request:start");
  });
  type Untyped = (method: string, path: string, init?: Record<string, unknown>) => Promise<never>;

  function recording() {
    const seen: Request[] = [];
    server.events.on("request:start", ({ request }) => {
      seen.push(request.clone());
    });
    return seen;
  }

  it("does not follow a redirect and does not retry it", async () => {
    let calls = 0;
    server.use(
      http.get(url("/Voucher"), () => {
        calls++;
        return HttpResponse.redirect(url("/Contact"), 302);
      }),
      http.get(url("/Contact"), () => HttpResponse.json({ objects: ["followed"] })),
    );
    const { client } = setup({ retry: { maxRetries: 3 } });

    const error = await captureError(client.call(client.api.GET("/Voucher")));

    expect(error.kind).toBe("http_error");
    expect(error.message).toBe(
      "sevdesk answered with a redirect, which this server does not follow.",
    );
    expect(calls).toBe(1);
  });

  it("marks a redirected write as outcome unknown", async () => {
    server.use(http.post(url("/Contact"), () => HttpResponse.redirect(url("/Contact/1"), 303)));
    const { client } = setup();
    const error = await captureError(
      client.call(client.api.POST("/Contact", { body: {} as never })),
    );
    expect(error.message).toContain("does not follow.");
    expect(error.message).toContain("The outcome is unknown");
  });

  it("adds the token only after every check, so nothing before the network sees it", async () => {
    server.use(http.get(url("/Voucher"), () => HttpResponse.json({ objects: [] })));
    const beforeNetwork: Array<string | null> = [];
    const gate: RequestGate = {
      check: (request) => {
        beforeNetwork.push(request.headers.get("authorization"));
      },
      callRefused: () => {},
    };
    const seen = recording();
    const base = createSevdeskClient({ baseUrl: MOCK_BASE_URL, token: TEST_TOKEN });
    const client = restrictClient(base, gate);

    await client.call(client.api.GET("/Voucher"));

    expect(beforeNetwork).toEqual([null]);
    expect(seen.at(-1)?.headers.get("authorization")).toBe(TEST_TOKEN);
  });

  it("refuses middleware, client-wide and per call", async () => {
    const refused: string[] = [];
    const gate: RequestGate = {
      check: () => {},
      callRefused: (_m, reason) => refused.push(reason),
    };
    const client = restrictClient(
      createSevdeskClient({ baseUrl: MOCK_BASE_URL, token: TEST_TOKEN }),
      gate,
    );
    const middleware = { onRequest: ({ request }: { request: Request }) => request };

    expect(() => client.api.use(middleware)).toThrow(/Middleware is not allowed/);
    expect(() => client.api.eject(middleware)).toThrow(/Middleware is not allowed/);
    expect(() => client.api.GET("/Voucher", { middleware: [middleware] } as never)).toThrow(
      /per-call option "middleware" is not allowed/,
    );
    expect(refused).toEqual([
      "call_override:middleware",
      "call_override:middleware",
      "call_override:middleware",
    ]);
  });

  it.each([
    ["X-HTTP-Method-Override", { headers: { "X-HTTP-Method-Override": "DELETE" } }],
    ["X-HTTP-Method", { params: { header: { "X-HTTP-Method": "DELETE" } } }],
    ["X-Forwarded-Host", { headers: { "X-Forwarded-Host": "elsewhere.example" } }],
    ["Authorization", { headers: { Authorization: "other" } }],
  ])("refuses the request header %s before anything is sent", async (name, init) => {
    const seen = recording();
    const refused: string[] = [];
    const gate: RequestGate = {
      check: () => {},
      callRefused: (_m, reason) => refused.push(reason),
    };
    const client = restrictClient(
      createSevdeskClient({ baseUrl: MOCK_BASE_URL, token: TEST_TOKEN }),
      gate,
    );
    const before = seen.length;

    const error = await captureError(
      client.call((client.api.request as unknown as Untyped)("get", "/Voucher", init)),
    );

    expect(error.kind).toBe("policy");
    expect(error.message).toBe(
      `The request header "${name.toLowerCase()}" is not allowed on sevdesk requests. Nothing was sent.`,
    );
    expect(refused).toEqual([`header:${name.toLowerCase()}`]);
    expect(seen.length).toBe(before);
  });

  it("lets a caller choose Accept, e.g. for a PDF", async () => {
    server.use(http.get(url("/Voucher"), () => HttpResponse.json({ objects: [] })));
    const seen = recording();
    const { client } = setup();
    await client.call(client.api.GET("/Voucher", { headers: { Accept: "application/pdf" } }));
    expect(seen.at(-1)?.headers.get("accept")).toBe("application/pdf");
  });

  it.each(["_method", "_METHOD", "x-http-method-override"])(
    "refuses the method-override query %s",
    async (key) => {
      const seen = recording();
      const before = seen.length;
      const { client } = setup();
      const error = await captureError(
        client.call((client.api.request as unknown as Untyped)("get", `/Voucher?${key}=DELETE`)),
      );
      expect(error.kind).toBe("policy");
      expect(error.message).toContain(`"${key}" is not allowed`);
      expect(seen.length).toBe(before);
    },
  );
});
