/**
 * @kuzo-mcp/server-http — opt-in Streamable HTTP transport (Phase 4a §4.2) with
 * an OAuth Resource Server (Phase 4b §4.3/§6.3).
 *
 * Turns kuzo into a remote MCP server reachable over HTTP. This package is NOT
 * a default dependency: `kuzo serve --http` dynamic-imports it, so the stdio
 * CLI carries zero HTTP/OAuth weight and zero added network attack surface.
 *
 * Boot model (§4.2): `bootKuzo()` runs ONCE at startup (single decrypt / scrub
 * / loadAll / irreversible freeze, before the listener binds) and yields the
 * shared { registry, logger, shutdown, summaryLines } handle. Each HTTP session
 * gets its OWN low-level `Server` (`buildMcpServer(registry, logger)`) connected
 * to its OWN `StreamableHTTPServerTransport`. The registry/loader/store are
 * process-global singletons; sessions differ only in transport + Server wiring.
 * The tool list is therefore identical across sessions (no per-session scoping).
 *
 * Auth model (§4.3): kuzo is an OAuth 2.1 *Resource Server* — it VERIFIES bearer
 * tokens against an external Authorization Server's JWKS; it is NOT the AS. The
 * default mode mounts `mcpAuthMetadataRouter` (RFC 9728 protected-resource
 * metadata + re-advertised RFC 8414 AS metadata) and protects `/mcp` with
 * `requireBearerAuth` + our `verifyAccessToken` (signature + issuer + RFC 8707
 * audience). `noAuth` is the loopback-only dev path, hard-gated behind KUZO_DEV
 * by the CLI; the host check here is defense-in-depth.
 *
 * Scope (Phase 4b first step): the Resource Server is live and proven on
 * loopback against MCP Inspector with a locally-signed stub token. PUBLIC
 * exposure — non-loopback bind, CORS, `allowedHosts`, session cap/TTL — lands in
 * the next sub-step (AS pick + Cloudflare Tunnel), so this still binds loopback
 * in BOTH modes.
 *
 * Typing note: handlers are annotated with Node's `http` types (not express's)
 * so the package needs no express type dependency — `createMcpExpressApp`
 * provides express's json + host-header middleware at runtime, and express's
 * req/res are structural subtypes of IncomingMessage/ServerResponse. The auth
 * middleware/router are typed via `ReturnType<…>` for the same reason.
 *
 * Stateful caveat: session transports live in an in-memory, single-process Map.
 * A restart drops all sessions; the next client call 404s and the client
 * re-initializes. Fine for one user; rules out horizontal scaling.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  bootKuzo,
  buildMcpServer,
  attachShutdownHandlers,
  type RunServerOptions,
} from "@kuzo-mcp/core/server";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createRemoteJWKSet } from "jose";

import { resolveAuthConfig, type AuthOptions } from "./auth/config.js";
import { createAccessTokenVerifier } from "./auth/verifier.js";

export { resolveAuthConfig, type AuthOptions, type ResolvedAuth } from "./auth/config.js";
export { createAccessTokenVerifier, ASYMMETRIC_ALGS } from "./auth/verifier.js";
export type { AccessTokenVerifierConfig } from "./auth/verifier.js";

export interface ServeHttpOptions extends RunServerOptions {
  /** TCP port to listen on. Default 3000. */
  port?: number;
  /**
   * Bind host. Default 127.0.0.1. `createMcpExpressApp` auto-enables
   * DNS-rebinding (Host-header) protection for loopback hosts.
   */
  host?: string;
  /**
   * Run WITHOUT the OAuth Resource Server. The CLI gates this behind KUZO_DEV +
   * a loopback host. Default false → the OAuth Resource Server is mounted.
   */
  noAuth?: boolean;
  /**
   * OAuth Resource Server config (issuer / JWKS URL / canonical resource URL +
   * optional AS endpoints). Falls back to `KUZO_OAUTH_*` env vars. Ignored when
   * `noAuth` is true.
   */
  auth?: AuthOptions;
}

/** express.json() populates `body` on the incoming request at runtime. */
type McpHttpRequest = IncomingMessage & { body?: unknown };

// Loopback aliases permitted for binds in this sub-step. The literal IPs are
// guaranteed loopback; `localhost` is included for dev ergonomics but is
// resolved by the OS at bind time, so its loopback guarantee comes from the
// resolver (and the SDK's Host-header check), not this list (Security A1,
// PR #65).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Read the single-valued Mcp-Session-Id header. Node returns `string[]` if a
 * client sends the header more than once; treat anything non-string as "no
 * session" rather than casting the array away (Correctness A1, PR #65).
 */
function sessionIdHeader(req: McpHttpRequest): string | undefined {
  const raw = req.headers["mcp-session-id"];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Boot kuzo once and serve MCP over Streamable HTTP. The returned promise stays
 * pending until the process is shut down (SIGINT/SIGTERM via
 * `attachShutdownHandlers`); it rejects if the listener fails to bind.
 */
export async function serveHttp(options: ServeHttpOptions = {}): Promise<void> {
  const { port = 3000, host = "127.0.0.1", noAuth = false, auth, ...bootOptions } = options;

  // Scope guardrail (defense-in-depth; the CLI is the primary gate). Public
  // exposure — non-loopback bind + CORS + allowedHosts + session hardening — is
  // the NEXT 4b sub-step. Until then, bind loopback in BOTH modes; OAuth is
  // proven locally against MCP Inspector.
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `server-http: refusing to bind to a non-loopback host ("${host}"). ` +
        "Remote exposure (Cloudflare Tunnel + CORS + allowedHosts) lands in the next 4b sub-step.",
    );
  }

  // Build the OAuth Resource Server layer unless explicitly disabled. Resolve +
  // validate auth config BEFORE the (expensive, irreversible) bootKuzo decrypt
  // so a misconfig fails fast. `createRemoteJWKSet` is lazy — no network until
  // the first token verify. The metadata router is unauthenticated discovery;
  // `requireBearerAuth` protects the MCP routes.
  let authMiddleware: ReturnType<typeof requireBearerAuth>[] = [];
  let metadataRouter: ReturnType<typeof mcpAuthMetadataRouter> | undefined;
  if (!noAuth) {
    const resolved = resolveAuthConfig(auth);
    const verifier = createAccessTokenVerifier({
      keyResolver: createRemoteJWKSet(resolved.jwksUri),
      issuer: resolved.issuer,
      audience: resolved.resource.href,
    });
    authMiddleware = [
      requireBearerAuth({
        verifier,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resolved.resource),
      }),
    ];
    metadataRouter = mcpAuthMetadataRouter({
      oauthMetadata: resolved.oauthMetadata,
      resourceServerUrl: resolved.resource,
      scopesSupported: resolved.scopes,
      resourceName: "Kuzo MCP",
    });
  }

  // Boot ONCE, before the listener binds. One registry/loader/store shared
  // across every HTTP session.
  const handle = await bootKuzo(bootOptions);
  const { logger } = handle;

  // Per-session transports keyed by the Mcp-Session-Id header.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // express() + express.json() + Host-header validation. NOTE (Security A2):
  // DNS-rebinding protection here depends ENTIRELY on createMcpExpressApp
  // auto-enabling Host-header validation for loopback hosts — confirmed at
  // @modelcontextprotocol/sdk 1.25.3. It is the ONLY rebinding mitigation in
  // this package; a future SDK major bump MUST re-verify this contract.
  const app = createMcpExpressApp({ host });

  // Unauthenticated OAuth discovery (RFC 9728 protected-resource + re-advertised
  // RFC 8414 AS metadata). Mounted at root, before the protected MCP routes.
  if (metadataRouter !== undefined) {
    app.use(metadataRouter);
  }

  // POST /mcp — reuse the named session's transport, or create one on an
  // initialize request. A fresh low-level Server is built per session and
  // connected to that session's transport; all sessions share the global registry.
  app.post("/mcp", ...authMiddleware, async (req: McpHttpRequest, res: ServerResponse) => {
    const sessionId = sessionIdHeader(req);
    const existing = sessionId !== undefined ? transports.get(sessionId) : undefined;

    if (existing !== undefined) {
      await existing.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId !== undefined) {
      // Header named a session we don't know (e.g. the server restarted).
      sendJsonRpcError(res, 404, -32001, "Unknown or expired session");
      return;
    }

    if (!isInitializeRequest(req.body)) {
      // No session id and not an initialize — nothing to attach to.
      sendJsonRpcError(res, 400, -32000, "Bad Request: no Mcp-Session-Id and not an initialize request");
      return;
    }

    // Fresh session. Register the transport once it has an id; clean it up on
    // close. `transport` is a const, so the callbacks (which fire later, during
    // handleRequest) always see the fully-constructed instance.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
        // Log a short prefix, not the full UUID — the SID is the session's
        // routing key (Security A2, PR #65). 8 chars is enough to correlate
        // open/close locally without disclosing the whole key.
        logger.info(`HTTP MCP session opened: ${sid.slice(0, 8)}…`);
      },
      onsessionclosed: (sid) => {
        transports.delete(sid);
        logger.info(`HTTP MCP session closed: ${sid.slice(0, 8)}…`);
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid !== undefined) transports.delete(sid);
    };

    const server = buildMcpServer(handle.registry, logger);
    await server.connect(transport);

    await transport.handleRequest(req, res, req.body);
  });

  // GET (SSE stream) + DELETE (terminate) both require an existing session.
  // Inlined rather than shared so each stays a small, self-contained handler.
  app.get("/mcp", ...authMiddleware, async (req: McpHttpRequest, res: ServerResponse) => {
    const sessionId = sessionIdHeader(req);
    const transport = sessionId !== undefined ? transports.get(sessionId) : undefined;
    if (transport === undefined) {
      sendJsonRpcError(res, 404, -32001, "Unknown or expired session");
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", ...authMiddleware, async (req: McpHttpRequest, res: ServerResponse) => {
    const sessionId = sessionIdHeader(req);
    const transport = sessionId !== undefined ? transports.get(sessionId) : undefined;
    if (transport === undefined) {
      sendJsonRpcError(res, 404, -32001, "Unknown or expired session");
      return;
    }
    await transport.handleRequest(req, res);
  });

  // Bind and run. serveHttp resolves only at shutdown; it rejects on a bind
  // failure (e.g. EADDRINUSE) so the CLI can surface it.
  const authLabel = noAuth ? "no-auth" : "oauth";
  await new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => {
      logger.info(`Kuzo MCP HTTP server listening on http://${host}:${port}/mcp (${authLabel}, loopback)`);
      for (const line of handle.summaryLines) {
        process.stderr.write(`${line}\n`);
      }

      // Attach shutdown handlers ONLY after a successful bind (Correctness A2):
      // a failed bind rejects via the 'error' handler below and the CLI exits
      // with the right code — without a SIGINT racing an already-rejected boot
      // and forcing realExit(0). Teardown closes session transports, stops the
      // listener, then tears down shared boot resources (handle.shutdown is
      // idempotent — core PR #64 A1).
      attachShutdownHandlers(logger, async () => {
        for (const transport of transports.values()) {
          try {
            await transport.close();
          } catch {
            // best-effort — keep tearing down the rest
          }
        }
        await new Promise<void>((closed) => httpServer.close(() => closed()));
        await handle.shutdown();
        resolve();
      });
    });

    httpServer.on("error", (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      // Bind failed before we served anything (e.g. EADDRINUSE). Tear down the
      // boot resources we already created — close the encrypted store + wipe the
      // master-key buffer — before propagating, since the CLI exits via
      // process.exit and Node finalizers won't run (Correctness A1, PR #65 r3).
      // handle.shutdown is idempotent (core PR #64 A1), so this never collides
      // with the success-path teardown above.
      void handle.shutdown().finally(() => reject(error));
    });
  });
}
