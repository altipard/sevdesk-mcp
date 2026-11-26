import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import { JWT_ALGORITHMS } from "../config.js";

/** Clock skew for nbf (and exp in jose; the SDK re-checks exp strictly afterwards). */
export const CLOCK_TOLERANCE_SECONDS = 30;

/** RFC 9068 header type of JWT access tokens; ID tokens and other JWTs are refused. */
export const ACCESS_TOKEN_TYPE = "at+jwt";

// Errors that mean "the token is bad" (401). JWKS fetch and parse problems
// are left out on purpose: they surface as 500, and the request fails
// closed either way.
const TOKEN_ERRORS = [
  errors.JWTClaimValidationFailed,
  errors.JWTExpired, // not a subclass of JWTClaimValidationFailed in jose 6
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

export interface JwtVerifierOptions {
  /** Expected `iss`, exact string match. */
  issuer: string;
  /** Resource URL of this MCP server; the token's `aud` must contain it. */
  resource: URL;
  /** Key source, e.g. `createRemoteJWKSet(jwksUrl)`. */
  keys: JWTVerifyGetKey;
  /** Allowlist of JWS algorithms, asymmetric only. */
  algorithms: readonly string[];
}

const invalid = (message: string) => new OAuthError(OAuthErrorCode.InvalidToken, message);

/**
 * OAuth access token verifier for the bearer gate of the SDK. Checks the
 * signature against the issuer's keys, `typ: at+jwt`, `iss`, `aud`, `nbf`
 * and `exp` with clock skew, and requires `sub` and a client ID.
 *
 * `AuthInfo.resource` is the `aud` entry that matched, not the configured
 * URL, so the gate's `expectedResource` check is a second, independent
 * comparison instead of comparing the configuration with itself.
 */
export function createJwtVerifier(options: JwtVerifierOptions): OAuthTokenVerifier {
  if (options.algorithms.length === 0) throw new Error("JWT algorithm allowlist must not be empty");
  for (const alg of options.algorithms) {
    if (!(JWT_ALGORITHMS as readonly string[]).includes(alg)) {
      throw new Error(`JWT algorithm not allowed: ${alg}`);
    }
  }
  if (!options.issuer) throw new Error("JWT issuer must be set");

  const resource = new URL(options.resource.href);
  resource.hash = "";
  // Same normalisation as the SDK's expectedResource check: one trailing
  // slash is insignificant, which only matters for an origin-only URL.
  const audiences = [...new Set([resource.href, resource.href.replace(/\/$/, "")])];
  const algorithms = [...options.algorithms];

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, options.keys, {
          issuer: options.issuer,
          audience: audiences,
          algorithms,
          typ: ACCESS_TOKEN_TYPE,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          requiredClaims: ["exp", "sub"],
        }));
      } catch (error) {
        if (TOKEN_ERRORS.some((type) => error instanceof type)) {
          throw invalid("Invalid access token");
        }
        throw error;
      }

      const clientId = payload.client_id ?? payload.azp;
      if (typeof clientId !== "string" || clientId === "") {
        throw invalid("Access token has no client_id");
      }
      const scope = payload.scope ?? "";
      if (typeof scope !== "string") throw invalid("Access token scope claim is malformed");
      if (typeof payload.sub !== "string" || payload.sub === "") {
        throw invalid("Access token has no subject");
      }

      const aud = typeof payload.aud === "string" ? [payload.aud] : (payload.aud ?? []);
      const matched = aud.find((value) => audiences.includes(value));
      // jose already refused tokens without a matching aud; checked again so
      // the reported resource can only ever come from the token.
      if (matched === undefined) throw invalid("Invalid access token");

      return {
        token,
        clientId,
        scopes: scope.split(" ").filter(Boolean),
        // requiredClaims guarantees a numeric exp; the SDK rejects AuthInfo without it.
        expiresAt: payload.exp as number,
        resource: new URL(matched),
        extra: { sub: payload.sub },
      };
    },
  };
}
