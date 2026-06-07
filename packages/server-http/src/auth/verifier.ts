/**
 * OAuth Resource Server token verifier (Phase 4b §6.3).
 *
 * Implements the SDK's slim `OAuthTokenVerifier` — the ONLY piece of OAuth
 * machinery kuzo owns. kuzo is a Resource Server: it VERIFIES access tokens
 * against an external Authorization Server's published JWKS. It never mints
 * tokens, runs a login UI, or implements the big `OAuthServerProvider`.
 *
 * One `jose.jwtVerify` call enforces all four bindings:
 *   1. signature — against the AS's JWKS (asymmetric algs only, see below)
 *   2. issuer    — `iss` MUST equal the configured AS issuer
 *   3. audience  — `aud` MUST include the canonical MCP resource URL (RFC 8707),
 *                  so a token minted for a DIFFERENT resource cannot be replayed
 *                  here. This is THE binding control for "only my Claude" (§6.1).
 *   4. lifetime  — `exp`/`nbf` (jose enforces these for free).
 *
 * Algorithm allowlist: ONLY asymmetric signatures (RS, PS, ES families). A
 * public JWKS plus an HMAC (`HS256`) or `alg:none` token is the classic
 * alg-confusion forgery — the attacker signs with the public key as if it were
 * a shared HMAC secret.
 * Pinning `algorithms` closes that by construction.
 *
 * Any verification failure is rethrown as the SDK's `InvalidTokenError` so
 * `requireBearerAuth` answers 401 + `WWW-Authenticate` (a bare `Error` would map
 * to a 500). The raw bearer is recorded on `AuthInfo.token` for the request
 * context but is NEVER used as an outbound credential — kuzo's plugins
 * authenticate via their own broker creds, so the token is not "passed through"
 * to any upstream service (§6.3).
 */

import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/**
 * Asymmetric JWS algorithms only. NO `HS*` (symmetric) and NO `none` — verifying
 * a public-JWKS token under an HMAC alg is the alg-confusion attack.
 */
export const ASYMMETRIC_ALGS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
] as const;

export interface AccessTokenVerifierConfig {
  /**
   * jose key resolver. Production: `createRemoteJWKSet(new URL(jwksUri))`.
   * Tests: `createLocalJWKSet(jwks)`. Injecting it keeps the verifier
   * offline-testable and decoupled from how keys are fetched.
   */
  keyResolver: JWTVerifyGetKey;
  /** Expected `iss` — the Authorization Server's issuer identifier. */
  issuer: string;
  /**
   * Expected `aud` — the canonical MCP resource URL (RFC 8707), e.g.
   * `https://appletv.<domain>/mcp`. MUST match the URL the client entered.
   */
  audience: string;
}

/** Parse an OAuth `scope` (space-delimited) or `scp` (string | string[]) claim. */
function parseScopes(payload: JWTPayload): string[] {
  const claims = payload as Record<string, unknown>;
  const raw = claims["scope"] ?? claims["scp"];
  if (typeof raw === "string") return raw.split(" ").filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  return [];
}

/** First non-empty string claim among `keys`, else `fallback`. */
function firstStringClaim(payload: JWTPayload, keys: string[], fallback: string): string {
  const claims = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return fallback;
}

/**
 * Build an `OAuthTokenVerifier` bound to one issuer + audience + key resolver.
 * Pass the result to `requireBearerAuth({ verifier })`.
 */
export function createAccessTokenVerifier(config: AccessTokenVerifierConfig): OAuthTokenVerifier {
  const { keyResolver, issuer, audience } = config;
  const audienceUrl = new URL(audience);

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, keyResolver, {
          issuer,
          audience,
          algorithms: [...ASYMMETRIC_ALGS],
        }));
      } catch (err) {
        // Signature / iss / aud / exp / nbf / alg failures all funnel here.
        // Map to InvalidTokenError → 401 + WWW-Authenticate. The jose message
        // names the failed claim and contains no token material.
        throw new InvalidTokenError(err instanceof Error ? err.message : "Invalid access token");
      }

      // `requireBearerAuth` rejects a token with no numeric `expiresAt`. jose
      // already enforced `exp` when present; assert it exists so we never hand
      // the middleware an unbounded token.
      if (typeof payload.exp !== "number") {
        throw new InvalidTokenError("Access token has no expiration (exp) claim");
      }

      return {
        token,
        clientId: firstStringClaim(payload, ["client_id", "azp", "sub"], "unknown"),
        scopes: parseScopes(payload),
        expiresAt: payload.exp,
        resource: audienceUrl,
        extra: { sub: payload.sub, iss: payload.iss },
      };
    },
  };
}
