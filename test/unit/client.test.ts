import { delay, HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSevdeskClient, type SevdeskClientOptions } from "../../src/sevdesk/client.js";
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

  it("gives up after maxRetries", async () => {
    let calls = 0;
    server.use(
      http.get(url("/Voucher"), () => {
        calls++;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    const { client, sleeps } = setup({ retry: { maxRetries: 2 } });

    const error = await captureError(client.call(client.api.GET("/Voucher")));

    expect(error.kind).toBe("server_error");
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
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

  it.each([500, 503, 429])("sends a POST answered with %i exactly once", async (status) => {
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

  it("keeps the token out of network and timeout errors", async () => {
    server.use(http.get(url("/Invoice"), () => HttpResponse.error()));
    const { client, logLines } = setup({ retry: { maxRetries: 1 } });

    const error = await captureError(client.call(client.api.GET("/Invoice")));

    expect(errorRepresentations(error)).not.toContain(TEST_TOKEN);
    expect(logLines.join("")).not.toContain(TEST_TOKEN);
  });
});
