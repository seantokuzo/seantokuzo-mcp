/**
 * Verifier unit tests (Phase 4b §6.3). Mint tokens with an ephemeral keypair +
 * a local JWKS so the suite runs fully offline — no AS, no network. Covers the
 * happy path (AuthInfo mapping) and every rejection path, including the two
 * alg-confusion vectors (HS256 against a public JWKS, and `alg: none`).
 *
 * Run: KUZO_TEST=1 node --import tsx --test packages/server-http/src/auth/verifier.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  SignJWT,
  UnsecuredJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWTVerifyGetKey,
} from "jose";

import { createAccessTokenVerifier } from "./verifier.js";

const ISSUER = "https://as.test.example/";
const AUDIENCE = "https://appletv.test.example/mcp";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const isInvalidToken = (err: unknown): err is InvalidTokenError => err instanceof InvalidTokenError;

describe("createAccessTokenVerifier", () => {
  let signKey: CryptoKey;
  let jwks: JWTVerifyGetKey;
  let wrongJwks: JWTVerifyGetKey;

  before(async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    signKey = privateKey;
    const publicJwk = await exportJWK(publicKey);
    publicJwk.alg = "RS256";
    publicJwk.kid = "k1";
    jwks = createLocalJWKSet({ keys: [publicJwk] });

    // A DIFFERENT keypair, advertised under the same kid — used to prove a
    // signature minted by `signKey` does NOT verify against it.
    const other = await generateKeyPair("RS256", { extractable: true });
    const otherJwk = await exportJWK(other.publicKey);
    otherJwk.alg = "RS256";
    otherJwk.kid = "k1";
    wrongJwks = createLocalJWKSet({ keys: [otherJwk] });
  });

  /** Mint an RS256 token signed with `signKey`; overrides tweak iss/aud/exp/claims. */
  function mint(opts: {
    iss?: string;
    aud?: string;
    exp?: number | string;
    claims?: Record<string, unknown>;
    setExp?: boolean;
  } = {}): Promise<string> {
    const jwt = new SignJWT(opts.claims ?? { scope: "mcp:use", client_id: "claude-test" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setSubject("sean");
    if (opts.setExp !== false) jwt.setExpirationTime(opts.exp ?? "5m");
    return jwt.sign(signKey);
  }

  it("accepts a valid token and maps it to AuthInfo", async () => {
    const verifier = createAccessTokenVerifier({ keyResolver: jwks, issuer: ISSUER, audience: AUDIENCE });
    const token = await mint();
    const info = await verifier.verifyAccessToken(token);

    assert.equal(info.token, token);
    assert.equal(info.clientId, "claude-test");
    assert.deepEqual(info.scopes, ["mcp:use"]);
    assert.equal(typeof info.expiresAt, "number");
    assert.ok((info.expiresAt ?? 0) > nowSeconds());
    assert.equal(info.resource?.href, AUDIENCE);
    assert.equal(info.extra?.["sub"], "sean");
    assert.equal(info.extra?.["iss"], ISSUER);
  });

  it("falls back through client_id → azp → sub for clientId", async () => {
    const verifier = createAccessTokenVerifier({ keyResolver: jwks, issuer: ISSUER, audience: AUDIENCE });
    const token = await mint({ claims: { scope: "mcp:use" } }); // no client_id/azp
    const info = await verifier.verifyAccessToken(token);
    assert.equal(info.clientId, "sean"); // sub
  });

  it("rejects a token minted for a different audience (RFC 8707)", async () => {
    const verifier = createAccessTokenVerifier({ keyResolver: jwks, issuer: ISSUER, audience: AUDIENCE });
    const token = await mint({ aud: "https://evil.test.example/mcp" });
    await assert.rejects(verifier.verifyAccessToken(token), isInvalidToken);
  });

  it("rejects a token from a different issuer", async () => {
    const verifier = createAccessTokenVerifier({ keyResolver: jwks, issuer: ISSUER, audience: AUDIENCE });
    const token = await mint({ iss: "https://evil.test.example/" });
    await assert.rejects(verifier.verifyAccessToken(token), isInvalidToken);
  });

  it("rejects an expired token", async () => {
    const verifier = createAccessTokenVerifier({ keyResolver: jwks, issuer: ISSUER, audience: AUDIENCE });
    const token = await mint({ exp: nowSeconds() - 60 });
    await assert.rejects(verifier.verifyAccessToken(token), isInvalidToken);
  });

  it("rejects a token whose signature doesn't match the JWKS", async () => {
    const verifier = createAccessTokenVerifier({ keyResolver: wrongJwks, issuer: ISSUER, audience: AUDIENCE });
    const token = await mint();
    await assert.rejects(verifier.verifyAccessToken(token), isInvalidToken);
  });

  it("rejects an HS256 token against a public JWKS (alg-confusion guard)", async () => {
    const verifier = createAccessTokenVerifier({ keyResolver: jwks, issuer: ISSUER, audience: AUDIENCE });
    const secret = new TextEncoder().encode("a-32-byte-or-longer-shared-secret-xxxxx");
    const token = await new SignJWT({ scope: "mcp:use" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(secret);
    await assert.rejects(verifier.verifyAccessToken(token), isInvalidToken);
  });

  it("rejects an unsigned (alg: none) token", async () => {
    const verifier = createAccessTokenVerifier({ keyResolver: jwks, issuer: ISSUER, audience: AUDIENCE });
    const token = new UnsecuredJWT({ scope: "mcp:use" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .encode();
    await assert.rejects(verifier.verifyAccessToken(token), isInvalidToken);
  });

  it("rejects a token with no expiration (exp) claim", async () => {
    const verifier = createAccessTokenVerifier({ keyResolver: jwks, issuer: ISSUER, audience: AUDIENCE });
    const token = await mint({ setExp: false });
    await assert.rejects(verifier.verifyAccessToken(token), isInvalidToken);
  });

  it("rejects a malformed (non-JWT) bearer string", async () => {
    const verifier = createAccessTokenVerifier({ keyResolver: jwks, issuer: ISSUER, audience: AUDIENCE });
    await assert.rejects(verifier.verifyAccessToken("not-a-jwt"), isInvalidToken);
  });
});
