/**
 * @kuzo-mcp/server-http — opt-in Streamable HTTP transport (Phase 4a §4.2).
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
 * 4a scope: loopback + `--no-auth` ONLY. The OAuth Resource Server lands in 4b;
 * until then this refuses to serve unauthenticated traffic off loopback. The
 * CLI is the primary gate (KUZO_DEV + loopback host); the checks here are
 * defense-in-depth.
 *
 * Typing note: handlers are annotated with Node's `http` types (not express's)
 * so the package needs no express type dependency — `createMcpExpressApp`
 * provides express's json + host-header middleware at runtime, and express's
 * req/res are structural subtypes of IncomingMessage/ServerResponse.
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
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export interface ServeHttpOptions extends RunServerOptions {
  /** TCP port to listen on. Default 3000. */
  port?: number;
  /**
   * Bind host. Default 127.0.0.1. `createMcpExpressApp` auto-enables
   * DNS-rebinding (Host-header) protection for loopback hosts.
   */
  host?: string;
  /**
   * Run WITHOUT an OAuth Resource Server. In 4a this is the ONLY supported mode
   * and MUST be true — the CLI gates it behind KUZO_DEV + a loopback host. 4b
   * adds real auth and flips the default.
   */
  noAuth?: boolean;
}

/** express.json() populates `body` on the incoming request at runtime. */
type McpHttpRequest = IncomingMessage & { body?: unknown };

// Loopback aliases permitted for --no-auth binds. The literal IPs are
// guaranteed loopback; `localhost` is included for dev ergonomics but is
// resolved by the OS at bind time, so its loopback guarantee comes from the
// resolver (and the SDK's Host-header check), not this list (Security A1,
// PR #65). KUZO_DEV-gated either way.
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
  const { port = 3000, host = "127.0.0.1", noAuth = false, ...bootOptions } = options;

  // 4a guardrail (defense-in-depth; the CLI is the primary gate). No OAuth
  // Resource Server exists until 4b, so the only safe HTTP mode is loopback +
  // no-auth. Refuse anything else rather than expose an open, unauthenticated
  // endpoint on a routable interface.
  if (!noAuth) {
    throw new Error(
      "server-http: OAuth is not available until Phase 4b. Run with noAuth + a loopback host (the CLI enforces KUZO_DEV).",
    );
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `server-http: --no-auth is loopback-only; refusing to bind an unauthenticated server to "${host}".`,
    );
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

  // POST /mcp — reuse the named session's transport, or create one on an
  // initialize request. A fresh low-level Server is built per session and
  // connected to that session's transport; all sessions share the global registry.
  app.post("/mcp", async (req: McpHttpRequest, res: ServerResponse) => {
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
  app.get("/mcp", async (req: McpHttpRequest, res: ServerResponse) => {
    const sessionId = sessionIdHeader(req);
    const transport = sessionId !== undefined ? transports.get(sessionId) : undefined;
    if (transport === undefined) {
      sendJsonRpcError(res, 404, -32001, "Unknown or expired session");
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req: McpHttpRequest, res: ServerResponse) => {
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
  await new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => {
      logger.info(`Kuzo MCP HTTP server listening on http://${host}:${port}/mcp (no-auth, loopback)`);
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
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
