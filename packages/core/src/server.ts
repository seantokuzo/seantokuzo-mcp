/**
 * MCP Server — Phase 2.6 §C.1 boot sequence.
 *
 * Top-level entry is `runServer(options?)` (exported). The CLI's future
 * `kuzo serve` (Theme 9) and the 2.5e parity test both reach the server
 * through `runServer`; the self-invocation guard at the bottom only fires
 * when this file is the process entry point.
 *
 * Boot order (pinned by §C.1 — see invariants comment near `runServer`):
 *   1.  installExitGuard               (before anything that spawns children)
 *   2.  ConfigManager + loadDotenv     (populates process.env from .env)
 *   3.  ConsentStore + AuditLogger     (paths via @kuzo-mcp/core/paths)
 *   4.  chooseKeyProvider + EncryptedCredentialStore   (both INERT — no I/O)
 *   5.  collectDeclaredCredentialEnvNames               (static manifest read)
 *   6.  collectEnvOverrides                             (snapshot process.env)
 *   7.  scrubProcessEnv                                  (BEFORE any plugin import)
 *   8.  CredentialSource(envOverrides + store)
 *   9.  PluginRegistry + PluginLoader (credentialSource is the new 6th arg)
 *   10. loader.loadAll() — parent-eager decrypt fires inside if needed
 *   11. freezePrototypes (must run AFTER loadAll per 2.5e A.9 fix)
 *   12. MCP transport connect
 *   13. shutdown hooks (loader → registry → credentialStore.close → server.close)
 */

import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";

import { AuditLogger } from "./audit.js";
import { ConfigManager } from "./config.js";
import { ConsentStore } from "./consent.js";
import {
  CredentialSource,
  EncryptedCredentialStore,
  collectEnvOverrides,
  scrubProcessEnv,
} from "./credentials/index.js";
import { chooseKeyProvider } from "./key-provider-choice.js";
import { PluginLoader } from "./loader.js";
import { KuzoLogger } from "./logger.js";
import { collectDeclaredCredentialEnvNames } from "./manifest-env-names.js";
import { kuzoHome, credentialsFilePath } from "./paths.js";
import { PluginRegistry } from "./registry.js";

/** Convert a Zod schema to MCP-compatible JSON Schema */
function zodToMcpInputSchema(
  schema: Parameters<typeof zodToJsonSchema>[0],
): { type: "object"; properties?: Record<string, unknown>; required?: string[] } {
  const raw = zodToJsonSchema(schema) as Record<string, unknown>;
  return {
    type: "object",
    ...(raw["properties"]
      ? { properties: raw["properties"] as Record<string, unknown> }
      : {}),
    ...(Array.isArray(raw["required"])
      ? { required: raw["required"] as string[] }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Intrinsic hardening
// ---------------------------------------------------------------------------
//
// The exit guard installs early (before anything plugin-adjacent runs). The
// prototype freeze happens *after* the loader imports plugin manifests, because
// freezing Object.prototype breaks common JS patterns like TypeScript's
// transpiled namespace IIFE (e.g. `errorUtil.toString = ...` on a plain object
// inherits a now-read-only toString from the frozen prototype, and strict-mode
// ESM throws). Deferring the freeze until after manifest import:
//   - Keeps zero tool-call execution in the parent pre-freeze (2.5d moved all
//     plugin code to child processes; parent only reads manifests during
//     loader.loadAll).
//   - Seals the parent before the server starts serving any MCP requests.
//
// Children run without frozen prototypes today (plugin-host doesn't freeze);
// that's a separate hardening gap tracked for 2.5e+.

/** Stash the real process.exit for core shutdown paths */
const realExit: (code?: number) => never = process.exit.bind(process);

function installExitGuard(logger: KuzoLogger): void {
  process.exit = ((code?: number) => {
    logger.error(`Blocked process.exit(${code}) — a plugin tried to kill the server`);
  }) as typeof process.exit;
  logger.info("process.exit guard installed");
}

function freezePrototypes(logger: KuzoLogger): void {
  Object.freeze(Object.prototype);
  Object.freeze(Array.prototype);
  Object.freeze(Function.prototype);
  Object.freeze(RegExp.prototype);
  Object.freeze(String.prototype);
  Object.freeze(Number.prototype);
  Object.freeze(Boolean.prototype);
  logger.info("Intrinsic prototypes frozen");
}

// ---------------------------------------------------------------------------
// MCP request handlers
// ---------------------------------------------------------------------------

function buildMcpServer(registry: PluginRegistry, logger: KuzoLogger): Server {
  const server = new Server(
    { name: "kuzo-mcp", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const registeredTools = registry.getAllTools();
    const tools = registeredTools.map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToMcpInputSchema(tool.inputSchema),
    }));
    return { tools };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const registeredResources = registry.getAllResources();
    const resources = registeredResources.map(({ resource }) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }));
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const entry = registry.findResource(uri);

    if (!entry) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    const content = await entry.resource.handler(entry.context);
    return {
      contents: [{ uri, mimeType: entry.resource.mimeType, text: content }],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const entry = registry.findTool(name);
      if (!entry) {
        throw new Error(`Unknown tool: ${name}`);
      }

      const validated = entry.tool.inputSchema.parse(args ?? {});
      const result = await entry.tool.handler(validated, entry.context);

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Tool "${name}" failed: ${message}`);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, error: message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

const FORCE_EXIT_MS = 10_000;

function attachShutdownHandlers(
  logger: KuzoLogger,
  cleanup: () => Promise<void>,
): void {
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    const forceTimer = setTimeout(() => {
      logger.error(`Shutdown timed out after ${FORCE_EXIT_MS}ms — forcing exit`);
      realExit(1);
    }, FORCE_EXIT_MS);
    forceTimer.unref();

    logger.info("Shutting down...");
    await cleanup();
    realExit(0);
  };

  process.on("SIGINT", () => {
    void shutdown().catch((err) => {
      logger.error("Shutdown failed", err);
      realExit(1);
    });
  });
  process.on("SIGTERM", () => {
    void shutdown().catch((err) => {
      logger.error("Shutdown failed", err);
      realExit(1);
    });
  });
}

// ---------------------------------------------------------------------------
// runServer — the top-level boot orchestrator
// ---------------------------------------------------------------------------

export interface RunServerOptions {
  /**
   * Skip the declared-env-name scrub. `KUZO_PASSPHRASE` and
   * `KUZO_NO_ENV_SCRUB` are still scrubbed unconditionally per spec §A.7
   * `ALWAYS_SCRUB`. Debug only — emits a loud warning + audit event.
   */
  scrub?: boolean;
}

/**
 * Spec-pinned invariants (§C.1, also referenced by the §C.9 ESLint rule):
 *   1. `collectEnvOverrides()` must run BEFORE `scrubProcessEnv()`.
 *   2. `scrubProcessEnv()` must run BEFORE `loader.loadAll()`.
 *   3. `loader.loadAll()` must run BEFORE `freezePrototypes()` (2.5e A.9).
 *   4. `credentialStore.close()` must run AFTER `loader.shutdownAll()`.
 *   5. No `child_process` spawn between step 2 (ConfigManager) and step 7
 *      (scrub). Enforced by the ESLint rule in `eslint.config.js` for
 *      `server.ts` and `loader.ts`.
 *   6. Step 5 (manifest read) MUST NOT `import()` plugin entry modules —
 *      static `package.json#kuzoPlugin` only.
 *   7. `KUZO_PASSPHRASE` and `KUZO_NO_ENV_SCRUB` are scrubbed unconditionally.
 */
export async function runServer(options: RunServerOptions = {}): Promise<void> {
  const doScrub = options.scrub !== false;
  const logger = new KuzoLogger("server");
  logger.info("Starting Kuzo MCP Server...");

  // 1. Exit guard (before anything that spawns children)
  installExitGuard(logger);

  // 2. Config + dotenv
  const configManager = new ConfigManager();

  // 3. Consent + audit — paths via @kuzo-mcp/core/paths so KUZO_HOME applies
  const consentStore = new ConsentStore({ consentDir: kuzoHome() });
  const auditLogger = new AuditLogger({
    logDir: kuzoHome(),
    logger: new KuzoLogger("audit"),
  });

  // 4. Credential store + key provider (INERT — no I/O, no decrypt)
  const keyProvider = chooseKeyProvider(auditLogger);
  const credentialStore = new EncryptedCredentialStore({
    filePath: credentialsFilePath(),
    keyProvider,
    auditLogger,
    logger,
  });

  // 5. Build declared credential env-name set from static manifests
  //    (`package.json#kuzoPlugin.capabilities`, baked in Theme 0). NO dynamic
  //    `import()` of plugin entry modules — invariant 6.
  const declaredEnvNames = collectDeclaredCredentialEnvNames(
    configManager.getPluginConfig(),
    logger,
  );

  // 6. Collect env overrides matching declared names + KUZO_TOKEN_* pattern
  const envOverrides = collectEnvOverrides(declaredEnvNames);

  // 7. Scrub matched names from process.env BEFORE any child can inherit.
  //    KUZO_PASSPHRASE and KUZO_NO_ENV_SCRUB are scrubbed unconditionally by
  //    scrubProcessEnv's ALWAYS_SCRUB list — neither --no-scrub nor the env
  //    kill-switch exempts them. PassphraseKeyProvider captured the value
  //    at construction in step 4; the cached field survives the scrub.
  if (doScrub) {
    scrubProcessEnv(
      [...declaredEnvNames, ...Object.keys(envOverrides)],
      auditLogger,
    );
  } else {
    // --no-scrub: declared-env-names stay in process.env, but ALWAYS_SCRUB
    // entries are still removed (passphrase, kill-switch self). Audit-emit
    // the CLI-flag reason explicitly; scrubProcessEnv handles the env-var
    // kill-switch path internally.
    scrubProcessEnv([], auditLogger);
    logger.warn(
      "process.env scrubbing DISABLED (--no-scrub). Plugin children may inherit credential env vars. KUZO_PASSPHRASE is still scrubbed.",
    );
    auditLogger.log({
      plugin: "kuzo",
      action: "credential.scrub_disabled",
      outcome: "allowed",
      details: { reason: "--no-scrub flag" },
    });
  }

  // 8. Credential source — env overrides win over store; store stays cold
  //    until the first store.get() lands in step 10.
  const credentialSource = new CredentialSource(credentialStore, envOverrides);

  // 9. Plugin loader — credentialSource is the new 6th constructor arg
  const registry = new PluginRegistry(new KuzoLogger("registry"));
  const loader = new PluginLoader(
    registry,
    configManager,
    new KuzoLogger("loader"),
    consentStore,
    auditLogger,
    credentialSource,
  );

  // 10. Load plugins. Parent-eager decrypt: the first plugin that needs a
  //     stored credential triggers keyProvider.acquireKey() → decrypt → cache.
  //     If every plugin's required credentials are satisfied by env overrides,
  //     the keychain is never touched.
  const loadResult = await loader.loadAll();

  // 11. Freeze prototypes now that manifest imports are done but before
  //     serving any MCP requests. See the hardening note above.
  freezePrototypes(logger);

  if (loadResult.loaded.length === 0 && loadResult.failed.length > 0) {
    logger.error("No plugins loaded and some failed — check your configuration");
  }

  // 12. Build + connect MCP server over stdio
  const server = buildMcpServer(registry, logger);

  // 13. Shutdown hooks. credentialStore.close() must run AFTER
  //     loader.shutdownAll() per invariant 4 (file-watch + IPC race).
  attachShutdownHandlers(logger, async () => {
    await loader.shutdownAll();
    await registry.shutdownAll();
    credentialStore.close();
    await server.close();
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("Kuzo MCP Server running on stdio");
}

// ---------------------------------------------------------------------------
// Self-invocation guard (round-4 B2)
// ---------------------------------------------------------------------------
//
// Boot only when this file is the process entry point. Importing
// `runServer` from `@kuzo-mcp/core` (Theme 9's `kuzo serve` CLI, future
// tests) MUST NOT auto-boot the server. The 2.5e parity test runs
// `node packages/core/dist/server.js` directly and depends on this guard
// firing.

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`kuzo server failed: ${message}\n`);
    realExit(1);
  });
}
