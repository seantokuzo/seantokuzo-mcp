/**
 * OAuth Resource Server config resolution (Phase 4b §4.3 / §6.3).
 *
 * Turns CLI flags / env vars into a validated `{ issuer, jwksUri, resource,
 * oauthMetadata }` bundle. AS-agnostic: the RS only needs the AS issuer, the AS
 * JWKS URL, and the canonical MCP resource URL — independent of WHICH managed
 * Authorization Server we later pick.
 *
 * `oauthMetadata` is the RFC 8414 Authorization-Server metadata that
 * `mcpAuthMetadataRouter` re-advertises at `/.well-known/oauth-authorization-server`
 * so an MCP client can discover where to authorize. For a real managed AS the
 * endpoint URLs come from its own discovery doc; here we accept explicit
 * overrides and otherwise derive RFC-conformant defaults from the issuer. We
 * validate the assembled doc against the SDK's own schema so a malformed bundle
 * fails fast at boot, not at the first client request.
 */

import { OAuthMetadataSchema, type OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

/** Auth inputs, from CLI flags or (as a fallback) the env vars below. */
export interface AuthOptions {
  issuer?: string;
  jwksUri?: string;
  resource?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  /** Scopes the AS supports / the RS advertises. */
  scopes?: string[];
}

export interface ResolvedAuth {
  /**
   * The AS issuer identifier, VERBATIM as configured. JWT `iss` is compared by
   * exact string (RFC 7519 §4.1.1) — no URL normalization — so this must equal
   * the string the AS stamps into its tokens (mind the trailing slash: Auth0
   * uses one, many others don't).
   */
  issuer: string;
  jwksUri: URL;
  resource: URL;
  oauthMetadata: OAuthMetadata;
  scopes: string[] | undefined;
}

/** Env-var names backing each option (CLI flag wins when both are set). */
const ENV = {
  issuer: "KUZO_OAUTH_ISSUER",
  jwksUri: "KUZO_OAUTH_JWKS_URI",
  resource: "KUZO_OAUTH_RESOURCE",
  authorizationEndpoint: "KUZO_OAUTH_AUTHORIZATION_ENDPOINT",
  tokenEndpoint: "KUZO_OAUTH_TOKEN_ENDPOINT",
  registrationEndpoint: "KUZO_OAUTH_REGISTRATION_ENDPOINT",
  scopes: "KUZO_OAUTH_SCOPES",
} as const;

function requireUrl(value: string | undefined, label: string, envName: string): URL {
  if (value === undefined || value.trim() === "") {
    throw new Error(`OAuth Resource Server needs ${label}. Pass it via the CLI flag or ${envName}.`);
  }
  try {
    return new URL(value);
  } catch {
    throw new Error(`OAuth ${label} is not a valid absolute URL: "${value}" (${envName}).`);
  }
}

function optionalUrl(value: string | undefined, label: string, envName: string): URL | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    return new URL(value);
  } catch {
    throw new Error(`OAuth ${label} is not a valid absolute URL: "${value}" (${envName}).`);
  }
}

/** Resolve an endpoint relative to the issuer, preserving any issuer path. */
function endpointFromIssuer(issuer: URL, segment: string): URL {
  const base = issuer.pathname.endsWith("/") ? issuer : new URL(`${issuer.href}/`);
  return new URL(segment, base);
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export function resolveAuthConfig(options: AuthOptions = {}): ResolvedAuth {
  const env = process.env;

  // Issuer is kept VERBATIM for the token `iss` check (exact-string match), but
  // validated as a URL (RFC 8414 requires it to be one) and reused as the base
  // for endpoint derivation.
  const issuerIdentifier = (options.issuer ?? env[ENV.issuer] ?? "").trim();
  const issuerUrl = requireUrl(issuerIdentifier, "an issuer URL", ENV.issuer);
  const jwksUri = requireUrl(options.jwksUri ?? env[ENV.jwksUri], "a JWKS URL", ENV.jwksUri);
  const resource = requireUrl(options.resource ?? env[ENV.resource], "a resource URL", ENV.resource);

  const authorizationEndpoint =
    optionalUrl(
      options.authorizationEndpoint ?? env[ENV.authorizationEndpoint],
      "authorization_endpoint",
      ENV.authorizationEndpoint,
    ) ?? endpointFromIssuer(issuerUrl, "authorize");
  const tokenEndpoint =
    optionalUrl(options.tokenEndpoint ?? env[ENV.tokenEndpoint], "token_endpoint", ENV.tokenEndpoint) ??
    endpointFromIssuer(issuerUrl, "token");
  const registrationEndpoint = optionalUrl(
    options.registrationEndpoint ?? env[ENV.registrationEndpoint],
    "registration_endpoint",
    ENV.registrationEndpoint,
  );

  const scopes = options.scopes ?? parseCsv(env[ENV.scopes]);

  // Validate against the SDK's own RFC 8414 schema so a malformed metadata
  // bundle is caught at boot. `S256`-only PKCE + `code` flow are the MCP
  // baseline; `registration_endpoint` (DCR) is advertised when configured.
  const oauthMetadata = OAuthMetadataSchema.parse({
    issuer: issuerIdentifier,
    authorization_endpoint: authorizationEndpoint.href,
    token_endpoint: tokenEndpoint.href,
    jwks_uri: jwksUri.href,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    ...(registrationEndpoint ? { registration_endpoint: registrationEndpoint.href } : {}),
    ...(scopes && scopes.length > 0 ? { scopes_supported: scopes } : {}),
  });

  return { issuer: issuerIdentifier, jwksUri, resource, oauthMetadata, scopes };
}
