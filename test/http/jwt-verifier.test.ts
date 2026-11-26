import {
  OAuthError,
  type OAuthTokenVerifier,
  verifyBearerToken,
} from "@modelcontextprotocol/server";
import {
  type CryptoKey,
  createLocalJWKSet,
  exportSPKI,
  importJWK,
  SignJWT,
  UnsecuredJWT,
} from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJwtVerifier } from "../../src/http/jwt-verifier.js";
import { type Issuer, makeKey, signToken, startIssuer } from "./support.js";

const RESOURCE = new URL("https://mcp.example.test/mcp");
let iss: Issuer;
let verifier: OAuthTokenVerifier;

beforeAll(async () => {
  iss = await startIssuer();
  verifier = createJwtVerifier({
    issuer: iss.issuer,
    resource: RESOURCE,
    keys: createLocalJWKSet({ keys: [iss.key.publicJwk] }),
    algorithms: ["RS256"],
  });
});
afterAll(() => iss.close());

const now = () => Math.floor(Date.now() / 1000);

async function expectInvalid(token: string, v: OAuthTokenVerifier = verifier) {
  const error = await v.verifyAccessToken(token).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OAuthError);
  expect((error as OAuthError).code).toBe("invalid_token");
}

describe("createJwtVerifier", () => {
  it("maps a valid token to AuthInfo", async () => {
    const token = await signToken(iss, RESOURCE.href, { scope: "sevdesk:read sevdesk:write" });
    const info = await verifier.verifyAccessToken(token);
    expect(info.clientId).toBe("client-1");
    expect(info.scopes).toEqual(["sevdesk:read", "sevdesk:write"]);
    expect(info.resource?.href).toBe(RESOURCE.href);
    expect(info.extra).toEqual({ sub: "user-1" });
  });

  it("reports the aud entry that matched as the resource, not the configuration", async () => {
    const root = createJwtVerifier({
      issuer: iss.issuer,
      resource: new URL("https://mcp.example.test/"),
      keys: createLocalJWKSet({ keys: [iss.key.publicJwk] }),
      algorithms: ["RS256"],
    });
    // The configured URL is "https://mcp.example.test/"; the token names it
    // without the slash, and that is what the gate gets to compare.
    const info = await root.verifyAccessToken(
      await signToken(iss, "", { audience: ["other", "https://mcp.example.test"] }),
    );
    expect(info.resource?.href).toBe("https://mcp.example.test/");
    const exact = await verifier.verifyAccessToken(
      await signToken(iss, "", { audience: ["https://elsewhere.test/mcp", RESOURCE.href] }),
    );
    expect(exact.resource?.href).toBe(RESOURCE.href);
  });

  it("accepts an aud array containing the resource; a trailing slash only for an origin-only resource", async () => {
    await verifier.verifyAccessToken(
      await signToken(iss, "", { audience: ["other", RESOURCE.href] }),
    );
    await expectInvalid(await signToken(iss, `${RESOURCE.href}/`));
    const root = createJwtVerifier({
      issuer: iss.issuer,
      resource: new URL("https://mcp.example.test"),
      keys: createLocalJWKSet({ keys: [iss.key.publicJwk] }),
      algorithms: ["RS256"],
    });
    await root.verifyAccessToken(await signToken(iss, "https://mcp.example.test"));
    await root.verifyAccessToken(await signToken(iss, "https://mcp.example.test/"));
  });

  it("rejects wrong audience and issuer", async () => {
    await expectInvalid(await signToken(iss, "https://other.example.test/mcp"));
    await expectInvalid(await signToken(iss, "https://mcp.example.test/mcp-other"));
    await expectInvalid(await signToken(iss, "https://mcp.example.test/mcp/sub"));
    await expectInvalid(
      await signToken(iss, RESOURCE.href, { issuer: "https://evil.example.test" }),
    );
    await expectInvalid(await signToken(iss, RESOURCE.href, { issuer: `${iss.issuer}/` }));
  });

  it("requires typ at+jwt (RFC 9068): missing or other types are refused", async () => {
    await expectInvalid(await signToken(iss, RESOURCE.href, { typ: null }));
    await expectInvalid(await signToken(iss, RESOURCE.href, { typ: "JWT" }));
    await expectInvalid(await signToken(iss, RESOURCE.href, { typ: "id_token+jwt" }));
    // The media type prefix form is the same type.
    await verifier.verifyAccessToken(
      await signToken(iss, RESOURCE.href, { typ: "application/at+jwt" }),
    );
  });

  it("applies 30 s clock skew to nbf: 10 s ahead is fine, 60 s ahead is refused", async () => {
    await verifier.verifyAccessToken(
      await signToken(iss, RESOURCE.href, { claims: { nbf: now() + 10 } }),
    );
    await expectInvalid(await signToken(iss, RESOURCE.href, { claims: { nbf: now() + 60 } }));
  });

  it("refuses tokens expired beyond the skew; within it the SDK gate decides (see http tests)", async () => {
    await expectInvalid(await signToken(iss, RESOURCE.href, { expiresIn: now() - 120 }));
    // jose alone accepts this one; the SDK re-checks exp strictly.
    const info = await verifier.verifyAccessToken(
      await signToken(iss, RESOURCE.href, { expiresIn: now() - 10 }),
    );
    await expect(verifyBearerToken(`Bearer ${info.token}`, { verifier })).rejects.toMatchObject({
      code: "invalid_token",
      message: "Token has expired",
    });
  });

  it("rejects a foreign key, with unknown kid and with a reused kid", async () => {
    await expectInvalid(await signToken(iss, RESOURCE.href, { key: await makeKey("unknown-kid") }));
    await expectInvalid(await signToken(iss, RESOURCE.href, { key: await makeKey(iss.key.kid) }));
  });

  it("rejects alg none, HS256 signed with the public key, and algorithms outside the allowlist", async () => {
    const unsecured = new UnsecuredJWT({ sub: "user-1", client_id: "c", scope: "sevdesk:read" })
      .setIssuer(iss.issuer)
      .setAudience(RESOURCE.href)
      .setExpirationTime("5m")
      .encode();
    await expectInvalid(unsecured);

    // Key confusion: HMAC "secret" = the issuer's own public key as PEM.
    const issuerPublicKey = await importJWK(iss.key.publicJwk, "RS256", { extractable: true });
    const pem = new TextEncoder().encode(await exportSPKI(issuerPublicKey as CryptoKey));
    const confused = await new SignJWT({ sub: "user-1", client_id: "c", scope: "sevdesk:read" })
      .setProtectedHeader({ alg: "HS256", kid: iss.key.kid, typ: "at+jwt" })
      .setIssuer(iss.issuer)
      .setAudience(RESOURCE.href)
      .setExpirationTime("5m")
      .sign(pem);
    await expectInvalid(confused);

    await expectInvalid(
      await signToken(iss, RESOURCE.href, { key: await makeKey(iss.key.kid, "RS512") }),
    );
    // ES256 key behind an RS256-only allowlist.
    const es = await makeKey("es-key", "ES256");
    const withEs = createJwtVerifier({
      issuer: iss.issuer,
      resource: RESOURCE,
      keys: createLocalJWKSet({ keys: [es.publicJwk] }),
      algorithms: ["RS256"],
    });
    await expectInvalid(await signToken(iss, RESOURCE.href, { key: es }), withEs);
  });

  it("rejects tokens without exp, sub or client id, and with a malformed scope claim", async () => {
    await expectInvalid(await signToken(iss, RESOURCE.href, { omit: ["exp"] }));
    await expectInvalid(await signToken(iss, RESOURCE.href, { omit: ["sub"] }));
    await expectInvalid(await signToken(iss, RESOURCE.href, { claims: { sub: "" } }));
    await expectInvalid(await signToken(iss, RESOURCE.href, { omit: ["client_id"] }));
    await expectInvalid(
      await signToken(iss, RESOURCE.href, { claims: { scope: ["sevdesk:read"] } }),
    );
    await expectInvalid("not-a-jwt");
  });

  it("falls back to azp when client_id is missing", async () => {
    const info = await verifier.verifyAccessToken(
      await signToken(iss, RESOURCE.href, { omit: ["client_id"], claims: { azp: "kc-client" } }),
    );
    expect(info.clientId).toBe("kc-client");
  });

  it("sets expiresAt from exp; the SDK refuses AuthInfo without it", async () => {
    const exp = now() + 300;
    const info = await verifier.verifyAccessToken(
      await signToken(iss, RESOURCE.href, { expiresIn: exp }),
    );
    expect(info.expiresAt).toBe(exp);
    const withoutExpiry: OAuthTokenVerifier = {
      verifyAccessToken: async (token) => ({
        token,
        clientId: "c",
        scopes: ["sevdesk:read"],
        resource: RESOURCE,
      }),
    };
    await expect(
      verifyBearerToken("Bearer abc", { verifier: withoutExpiry }),
    ).rejects.toMatchObject({ code: "invalid_token", message: "Token has no expiration time" });
  });

  it("lets JWKS failures through as non-OAuth errors (the gate answers 500, nothing passes)", async () => {
    const broken = createJwtVerifier({
      issuer: iss.issuer,
      resource: RESOURCE,
      keys: async () => {
        throw new Error("JWKS fetch failed");
      },
      algorithms: ["RS256"],
    });
    const error = await broken
      .verifyAccessToken(await signToken(iss, RESOURCE.href))
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(OAuthError);
  });

  it("refuses unsafe algorithm allowlists and a missing issuer at construction", () => {
    const base = { issuer: iss.issuer, resource: RESOURCE, keys: createLocalJWKSet({ keys: [] }) };
    expect(() => createJwtVerifier({ ...base, algorithms: [] })).toThrow(/must not be empty/);
    expect(() => createJwtVerifier({ ...base, algorithms: ["none"] })).toThrow(/not allowed/);
    expect(() => createJwtVerifier({ ...base, algorithms: ["RS256", "HS256"] })).toThrow(
      /not allowed/,
    );
    expect(() => createJwtVerifier({ ...base, issuer: "", algorithms: ["RS256"] })).toThrow(
      /issuer/,
    );
  });
});
