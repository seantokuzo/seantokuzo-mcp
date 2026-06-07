/**
 * Phase 4b stub Authorization Server — a LOCAL, throwaway AS for proving the
 * OAuth Resource Server end-to-end without a real managed AS. NOT shipped: it
 * lives outside `dist/`, and package.json `files` publishes only `dist/**`.
 *
 * It (1) generates an ephemeral RS256 keypair, (2) serves the public JWKS at
 * `/.well-known/jwks.json` (what kuzo's `createRemoteJWKSet` fetches) plus RFC
 * 8414 metadata at `/.well-known/oauth-authorization-server`, and (3) mints and
 * prints a valid stub access token (and a wrong-audience one for the negative
 * test) alongside the exact `kuzo serve --http` command.
 *
 * Usage:
 *   node packages/server-http/dev/stub-as.mjs
 *   AS_PORT=9000 RESOURCE=http://localhost:3000/mcp node packages/server-http/dev/stub-as.mjs
 *
 * `checkIssuerUrl` (SDK) permits an `http://localhost` issuer for exactly this.
 */

import { createServer } from "node:http";
import process from "node:process";

import { SignJWT, exportJWK, generateKeyPair } from "jose";

const AS_PORT = Number(process.env.AS_PORT ?? "9000");
const ISSUER = process.env.ISSUER ?? `http://localhost:${AS_PORT}`;
const RESOURCE = process.env.RESOURCE ?? "http://localhost:3000/mcp";
const SUBJECT = process.env.SUBJECT ?? "sean";
const SCOPE = process.env.SCOPE ?? "mcp:use";
const TTL_SECONDS = Number(process.env.TTL ?? "3600");
const KID = "kuzo-stub-key-1";

const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = KID;
publicJwk.alg = "RS256";
publicJwk.use = "sig";

const jwks = { keys: [publicJwk] };
const jwksUri = `${ISSUER}/.well-known/jwks.json`;

const asMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: jwksUri,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
};

function mintToken(audience) {
  return new SignJWT({ scope: SCOPE, client_id: "mcp-inspector-stub" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(SUBJECT)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(privateKey);
}

const validToken = await mintToken(RESOURCE);
const wrongAudToken = await mintToken("https://wrong.example/mcp");

const server = createServer((req, res) => {
  if (req.url === "/.well-known/jwks.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(jwks));
    return;
  }
  if (req.url === "/.well-known/oauth-authorization-server") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(asMetadata));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(AS_PORT, "127.0.0.1", () => {
  const line = "─".repeat(74);
  process.stdout.write(
    `
${line}
Kuzo stub Authorization Server — Phase 4b OAuth proving harness
${line}

  Issuer         ${ISSUER}
  JWKS URI       ${jwksUri}
  Resource/aud   ${RESOURCE}
  Token TTL      ${TTL_SECONDS}s

▶ 1. Start kuzo's Resource Server (another terminal):

   kuzo serve --http --auth-issuer ${ISSUER} --auth-jwks-uri ${jwksUri} --auth-resource ${RESOURCE}

▶ 2. MCP Inspector → Streamable HTTP → ${RESOURCE}
     Authentication → Bearer Token:

   ${validToken}

▶ 3. curl boundary checks (kuzo listening on :3000):

   # protected-resource metadata — unauthenticated, expect 200 JSON:
   curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp

   # no token — expect 401 + 'WWW-Authenticate: Bearer ... resource_metadata=...':
   curl -i -X POST http://localhost:3000/mcp \\
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\
     -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'

   # wrong-audience token — expect 401:
   curl -i -X POST http://localhost:3000/mcp \\
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\
     -H 'authorization: Bearer ${wrongAudToken}' \\
     -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'

Ctrl-C to stop.
${line}
`,
  );
});
