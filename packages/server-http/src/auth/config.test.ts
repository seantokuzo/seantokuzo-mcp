/**
 * Config-resolution tests (Phase 4b §4.3). Locks the load-bearing behaviors:
 * the issuer is kept VERBATIM (JWT `iss` is exact-string — a stray trailing
 * slash is the classic mismatch the live smoke test caught), required fields
 * throw a Claude-readable error naming the env var, and the RFC 8414 metadata
 * is assembled correctly.
 *
 * Run: KUZO_TEST=1 node --import tsx --test packages/server-http/src/auth/config.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveAuthConfig } from "./config.js";

const BASE = {
  issuer: "https://as.example.com",
  jwksUri: "https://as.example.com/.well-known/jwks.json",
  resource: "https://appletv.example.com/mcp",
};

describe("resolveAuthConfig", () => {
  it("keeps the issuer verbatim (no trailing-slash normalization)", () => {
    const resolved = resolveAuthConfig({ ...BASE, issuer: "https://as.example.com" });
    assert.equal(resolved.issuer, "https://as.example.com");
    assert.equal(resolved.oauthMetadata.issuer, "https://as.example.com");
  });

  it("preserves a trailing slash when the AS uses one (e.g. Auth0)", () => {
    const resolved = resolveAuthConfig({ ...BASE, issuer: "https://as.example.com/" });
    assert.equal(resolved.issuer, "https://as.example.com/");
    assert.equal(resolved.oauthMetadata.issuer, "https://as.example.com/");
  });

  it("derives authorize/token endpoints from the issuer by default", () => {
    const resolved = resolveAuthConfig(BASE);
    assert.equal(resolved.oauthMetadata.authorization_endpoint, "https://as.example.com/authorize");
    assert.equal(resolved.oauthMetadata.token_endpoint, "https://as.example.com/token");
  });

  it("preserves an issuer path when deriving endpoints", () => {
    const resolved = resolveAuthConfig({ ...BASE, issuer: "https://as.example.com/tenant1" });
    assert.equal(resolved.oauthMetadata.authorization_endpoint, "https://as.example.com/tenant1/authorize");
    assert.equal(resolved.oauthMetadata.token_endpoint, "https://as.example.com/tenant1/token");
  });

  it("honors explicit endpoint overrides", () => {
    const resolved = resolveAuthConfig({
      ...BASE,
      authorizationEndpoint: "https://login.example.com/oauth/authorize",
      tokenEndpoint: "https://login.example.com/oauth/token",
    });
    assert.equal(resolved.oauthMetadata.authorization_endpoint, "https://login.example.com/oauth/authorize");
    assert.equal(resolved.oauthMetadata.token_endpoint, "https://login.example.com/oauth/token");
  });

  it("advertises a registration_endpoint only when set (DCR)", () => {
    assert.equal(resolveAuthConfig(BASE).oauthMetadata.registration_endpoint, undefined);
    const withDcr = resolveAuthConfig({ ...BASE, registrationEndpoint: "https://as.example.com/register" });
    assert.equal(withDcr.oauthMetadata.registration_endpoint, "https://as.example.com/register");
  });

  it("advertises S256 PKCE + the code flow", () => {
    const { oauthMetadata } = resolveAuthConfig(BASE);
    assert.deepEqual(oauthMetadata.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(oauthMetadata.response_types_supported, ["code"]);
    assert.equal(oauthMetadata.jwks_uri, BASE.jwksUri);
  });

  it("exposes the resource as a URL and threads scopes through", () => {
    const resolved = resolveAuthConfig({ ...BASE, scopes: ["mcp:use", "mcp:admin"] });
    assert.equal(resolved.resource.href, "https://appletv.example.com/mcp");
    assert.deepEqual(resolved.scopes, ["mcp:use", "mcp:admin"]);
    assert.deepEqual(resolved.oauthMetadata.scopes_supported, ["mcp:use", "mcp:admin"]);
  });

  it("throws a Claude-readable error naming the missing env var", () => {
    assert.throws(() => resolveAuthConfig({ jwksUri: BASE.jwksUri, resource: BASE.resource }), /KUZO_OAUTH_ISSUER/);
    assert.throws(() => resolveAuthConfig({ issuer: BASE.issuer, resource: BASE.resource }), /KUZO_OAUTH_JWKS_URI/);
    assert.throws(() => resolveAuthConfig({ issuer: BASE.issuer, jwksUri: BASE.jwksUri }), /KUZO_OAUTH_RESOURCE/);
  });

  it("rejects a non-URL issuer", () => {
    assert.throws(() => resolveAuthConfig({ ...BASE, issuer: "not a url" }), /not a valid absolute URL/);
  });
});
