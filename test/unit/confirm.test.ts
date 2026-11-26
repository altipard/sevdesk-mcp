import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  argumentHash,
  canonicalJson,
  createConfirmationSigner,
  DEFAULT_CONFIRM_TTL_MS,
} from "../../src/policy/confirm.js";

const secret = Buffer.from("k".repeat(32));
const request = { tool: "mark_sent", args: { invoiceId: 1, note: "x" }, subject: "stdio" };

function signer(clock = { now: 1_000_000 }, key = secret) {
  return createConfirmationSigner({ secret: key, now: () => clock.now });
}

const reencode = (token: string, change: (claims: Record<string, unknown>) => void) => {
  const [v, payload, sig] = token.split(".") as [string, string, string];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  change(claims);
  return `${v}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;
};

describe("canonicalJson", () => {
  it("sorts keys at every level and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}',
    );
    expect(argumentHash({ a: 1, b: 2 })).toBe(argumentHash({ b: 2, a: 1 }));
    expect(argumentHash({ a: 1 })).not.toBe(argumentHash({ a: "1" }));
  });

  it("rejects values JSON cannot represent", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });
});

describe("confirmation tokens", () => {
  it("verifies a fresh token for the same request", () => {
    const s = signer();
    const { token, expiresAt } = s.issue(request);
    expect(expiresAt).toBe(1_000_000 + DEFAULT_CONFIRM_TTL_MS);
    const result = s.verify(token, { ...request, args: { note: "x", invoiceId: 1 } });
    expect(result).toMatchObject({ ok: true, claims: { tool: "mark_sent", subject: "stdio" } });
  });

  it("gives every token its own nonce", () => {
    const s = signer();
    const a = s.verify(s.issue(request).token, request);
    const b = s.verify(s.issue(request).token, request);
    expect(a.ok && b.ok && a.claims.nonce !== b.claims.nonce).toBe(true);
  });

  it("expires after the TTL", () => {
    const clock = { now: 1_000_000 };
    const s = signer(clock);
    const { token } = s.issue(request);
    clock.now += DEFAULT_CONFIRM_TTL_MS - 1;
    expect(s.verify(token, request).ok).toBe(true);
    clock.now += 1;
    expect(s.verify(token, request)).toEqual({ ok: false, reason: "expired" });
  });

  it.each([
    ["arguments", { ...request, args: { invoiceId: 2, note: "x" } }, "wrong_arguments"],
    ["extra argument", { ...request, args: { ...request.args, more: 1 } }, "wrong_arguments"],
    ["tool", { ...request, tool: "send_email" }, "wrong_tool"],
    ["subject", { ...request, subject: "sub:other" }, "wrong_subject"],
  ])("is bound to the %s", (_label, other, reason) => {
    const s = signer();
    expect(s.verify(s.issue(request).token, other)).toEqual({ ok: false, reason });
  });

  it("rejects manipulated claims", () => {
    const s = signer();
    const { token } = s.issue(request);
    for (const change of [
      (c: Record<string, unknown>) => {
        c.e = (c.e as number) + 3_600_000;
      },
      (c: Record<string, unknown>) => {
        c.s = "sub:admin";
      },
      (c: Record<string, unknown>) => {
        c.h = argumentHash({ invoiceId: 99 });
      },
    ]) {
      expect(s.verify(reencode(token, change), request)).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    }
  });

  it("rejects a token signed with another secret", () => {
    const token = signer({ now: 1_000_000 }, Buffer.from("o".repeat(32))).issue(request).token;
    expect(signer().verify(token, request)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each([
    ["empty", ""],
    ["garbage", "not-a-token"],
    ["wrong version", "v2.e30.abc"],
    ["extra part", "v1.a.b.c"],
    ["too long", `v1.${"a".repeat(5000)}.b`],
  ])("rejects a %s token", (_label, token) => {
    expect(signer().verify(token, request)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a validly signed token with an invalid payload", () => {
    // Only reachable with the secret; proves the parser is still strict.
    const body = `v1.${Buffer.from(JSON.stringify({ t: "mark_sent" })).toString("base64url")}`;
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    expect(signer().verify(`${body}.${sig}`, request)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a short secret", () => {
    expect(() => createConfirmationSigner({ secret: Buffer.from("short") })).toThrow(RangeError);
  });
});
