/**
 * MCP Server — Phase 2.6 §C.1 boot sequence.
 *
 * Two entry points:
 *   - `bootKuzo(options?)` — runs the one-shot boot sequence below exactly
 *     once and returns a shared { registry, logger, shutdown, summaryLines }
 *     handle. Every transport builds on it: stdio (`runServer`, below) and the
 *     opt-in `@kuzo-mcp/server-http` (Phase 4a) both call `bootKuzo` then
 *     `buildMcpServer(registry, logger)` per session.
 *   - `runServer(options?)` — boots + serves a single stdio session (the
 *     shipped default). `kuzo serve` and the 2.5e install-parity test reach
 *     the server through it; the self-invocation guard at the bottom only
 *     fires when this file is the process entry point.
 *
 * Boot order (pinned by §C.1 — see invariants comment near `runServer`):
 *   1.  installExitGuard               (before anything that spawns children)
 *   2.  ConfigManager + loadDotenv     (populates process.env from .env)
 *   3.  ConsentStore + FileBackedAuditLogger     (paths via @kuzo-mcp/core/paths)
 *       + emit `audit.partition_initialized` for forensic correlation
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

import { statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
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

import { FileBackedAuditLogger } from "./audit.js";
import { CHILD_PERMITTED_AUDIT_ACTIONS } from "./audit-partition.js";
import { ConfigManager } from "./config.js";
import { ConsentStore } from "./consent.js";
import {
  CredentialSource,
  EncryptedCredentialStore,
  collectEnvOverrides,
  scrubProcessEnv,
} from "./credentials/index.js";
import { debounce } from "./credentials/debounce.js";
import { chooseKeyProvider } from "./key-provider-choice.js";
import { PluginLoader } from "./loader.js";
import { KuzoLogger } from "./logger.js";
import { collectDeclaredCredentialEnvNames } from "./manifest-env-names.js";
import { credentialsFilePath } from "./paths.js";
import { PluginRegistry } from "./registry.js";
import { buildServeSummary } from "./serve-summary.js";

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

export function buildMcpServer(registry: PluginRegistry, logger: KuzoLogger): Server {
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

export function attachShutdownHandlers(
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
// bootKuzo — one-shot boot orchestrator (shared by every transport)
// ---------------------------------------------------------------------------

export interface RunServerOptions {
  /**
   * Whether to scrub declared-env-name values from `process.env` after
   * collecting env overrides at boot step 7. Defaults to `true`. Set to
   * `false` to keep the declared values readable from `process.env`
   * (debug only — emits a loud warning + audit event). `KUZO_PASSPHRASE`
   * and `KUZO_NO_ENV_SCRUB` are scrubbed unconditionally regardless of
   * this flag (spec §A.7 `ALWAYS_SCRUB`).
   */
  scrub?: boolean;
}

/**
 * Shared handle returned by {@link bootKuzo}. `registry` + `logger` are the
 * live singletons; `shutdown` tears down shared boot resources (rotation
 * watcher, loader children, registry, credential store) but NOT any per-session
 * MCP `Server` — the transport owner closes its own. `summaryLines` is the
 * §D.3 first-run UX, emitted to stderr by the transport owner after it connects.
 */
export interface BootHandle {
  registry: PluginRegistry;
  logger: KuzoLogger;
  shutdown: () => Promise<void>;
  summaryLines: string[];
}

/**
 * Runs the one-shot boot sequence (steps 1–11b) exactly once per process and
 * returns the shared {@link BootHandle}. `freezePrototypes` + `scrubProcessEnv`
 * are irreversible — call once, share the handle across sessions (stdio's
 * `runServer` and `@kuzo-mcp/server-http` both do exactly this).
 *
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
export async function bootKuzo(options: RunServerOptions = {}): Promise<BootHandle> {
  const doScrub = options.scrub !== false;
  const logger = new KuzoLogger("server");
  logger.info("Starting Kuzo MCP Server...");

  // 1. Exit guard (before anything that spawns children)
  installExitGuard(logger);

  // 2. Config + dotenv
  const configManager = new ConfigManager();

  // 3. Consent + audit. Both classes default their paths to `kuzoHome()`
  //    internally, so `KUZO_HOME` flows through without an explicit pass.
  //    `FileBackedAuditLogger` is the parent-owned writer per spec §C.10 —
  //    plugin children flow through `IpcAuditLogger` and reach this writer
  //    only via `plugin-process.handleAuditEvent`'s validation gauntlet.
  const consentStore = new ConsentStore();
  const auditLogger = new FileBackedAuditLogger({ logger: new KuzoLogger("audit") });

  // Forensic-correlation seed: emit the child-permitted action list exactly
  // once per server lifetime so audit reviewers can cross-reference any
  // subsequent `audit.forged_action` event without that event having to
  // re-embed the partition list per-entry (spec §C.10 nit N3).
  auditLogger.log({
    plugin: "kuzo",
    action: "audit.partition_initialized",
    outcome: "allowed",
    source: "parent",
    details: { permitted: Array.from(CHILD_PERMITTED_AUDIT_ACTIONS) },
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

  // 7. Scrub declared credential names from process.env BEFORE any child
  //    can inherit. KUZO_PASSPHRASE and KUZO_NO_ENV_SCRUB are scrubbed
  //    unconditionally by scrubProcessEnv's ALWAYS_SCRUB list — neither
  //    options.scrub=false nor the env kill-switch exempts them.
  //    PassphraseKeyProvider captured the value at construction in step 4;
  //    the cached field survives the scrub.
  //
  //    Round-1 security advisory (PR #50): pass declaredEnvNames ONLY, not
  //    `Object.keys(envOverrides)`. `collectEnvOverrides` accepts any
  //    `KUZO_TOKEN_<target>` and lands `<target>` in envOverrides — an
  //    attacker (or confused user) setting `KUZO_TOKEN_PATH=evil` would
  //    otherwise cause `scrubProcessEnv` to delete `process.env.PATH`.
  //    Narrowing to `declaredEnvNames` (with scrubProcessEnv's built-in
  //    twin-deletion still covering `KUZO_TOKEN_<declared>`) keeps the
  //    scrub surface bounded by the plugin manifest. The §A.12 reservation
  //    gate in Theme 7 is the install-time defense for third-party plugins.
  if (doScrub) {
    scrubProcessEnv([...declaredEnvNames], auditLogger);
  } else {
    // options.scrub=false: declared-env-names stay in process.env, but
    // ALWAYS_SCRUB entries (passphrase, kill-switch self) are still removed.
    // scrubProcessEnv emits credential.scrub_disabled itself when the env-var
    // kill-switch is active — only emit our own audit event when it didn't,
    // to avoid double-counting (round-1 Correctness advisory).
    const result = scrubProcessEnv([], auditLogger);
    logger.warn(
      "process.env scrubbing DISABLED (runServer options.scrub === false). Plugin children may inherit credential env vars. KUZO_PASSPHRASE is still scrubbed.",
    );
    if (!result.killSwitchActive) {
      auditLogger.log({
        plugin: "kuzo",
        action: "credential.scrub_disabled",
        outcome: "allowed",
        details: { reason: "options.scrub === false" },
      });
    }
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

  // 11b. Rotation cache invalidation (spec §C.11). Watch the credentials
  //      file's PARENT DIRECTORY — NOT the file (round-4 B14): `fs.watch` on
  //      the file watches an inode that the store's atomic tmp+rename rotation
  //      orphans, so rotation #2+ would silently stop firing. Watching the
  //      stable dir inode and filtering on the basename survives the rename.
  //      Only install when the store actually unlocked at boot — in
  //      env-override-only / NullKeyProvider mode the store stays cold and
  //      "rotation" means "restart with a new env var".
  let watcher: FSWatcher | undefined;

  // Last-seen credentials.enc stat ("mtimeMs:size"). We watch the whole kuzo
  // home DIR, so our OWN audit.log write (credential.refreshed_in_flight) is a
  // sibling-file change in the watched dir. On null-`filename` platforms that
  // event isn't attributable to a file, so the handler would run, write
  // audit.log again, and re-trigger itself — a permanent reload loop (R3
  // Security). Stat-guarding on credentials.enc makes a run a cheap no-op
  // unless the credential file ITSELF changed, which breaks the loop and also
  // collapses redundant events for the same content.
  let lastCredStat: string | undefined;

  const credFileSig = (): string | undefined => {
    try {
      const s = statSync(credentialsFilePath());
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      // Gone (e.g. mid-wipe) or unreadable. Skip — the next set/rotate event
      // re-creates the file and re-triggers us.
      return undefined;
    }
  };

  const handleCredentialFileChange = async (): Promise<void> => {
    // Settle delay: an atomic write (tmp+rename) can fire its watch event a
    // hair before the new file is fully in place. 250ms lets it settle before
    // we reload. Burst coalescing is handled by the refreshing/rerun guard in
    // the watch callback plus the stat check below, so this body does real
    // work at most once per actual credential change.
    await debounce(250);

    const sig = credFileSig();
    if (sig === undefined) return; // file gone (mid-wipe) — skip
    if (sig === lastCredStat) return; // unchanged (e.g. our own audit write) — no-op
    lastCredStat = sig;

    try {
      credentialStore.reload(); // re-decrypts; throws on corruption/tamper
    } catch (err) {
      // Never crash the server on a bad in-flight reload — log + audit and
      // keep the prior cache. The user's next `kuzo credentials status`
      // surfaces the broken state.
      auditLogger.log({
        plugin: "kuzo",
        action: "credential.refreshed_in_flight",
        outcome: "error",
        source: "parent",
        details: { error: err instanceof Error ? err.message : String(err) },
      });
      return;
    }

    // Re-resolve each plugin's scoped creds and push the refresh. For live
    // children this updates the running broker over IPC; for idle ones it
    // updates the stored env so they spawn fresh (see refreshCredentials).
    const procs = loader.runningProcesses();
    for (const proc of procs) {
      const { config } = credentialSource.extractForPlugin(proc.declaredCapabilities);
      proc.refreshCredentials(config);
    }
    auditLogger.log({
      plugin: "kuzo",
      action: "credential.refreshed_in_flight",
      outcome: "allowed",
      source: "parent",
      details: { count_refreshed: procs.length },
    });
  };

  if (credentialStore.isUnlocked()) {
    const credFile = credentialsFilePath();
    const watchDir = dirname(credFile);
    const credBasename = basename(credFile);
    // Collapse a multi-event rotation burst into a single refresh while still
    // catching a *distinct* rotation that lands mid-flight. Leading edge: the
    // first event runs the handler immediately. Trailing edge: events arriving
    // while it's in flight set `rerun`, so exactly ONE more refresh fires after
    // it settles. This closes the sub-ms window where a second rotation between
    // the reload and the flag reset would otherwise be dropped (R2 Security
    // advisory) without re-introducing N reloads for one burst.
    let refreshing = false;
    let rerun = false;
    const triggerRefresh = (): void => {
      if (refreshing) {
        rerun = true;
        return;
      }
      refreshing = true;
      void handleCredentialFileChange()
        .catch((err: unknown) => {
          logger.error(
            `credential refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          refreshing = false;
          if (rerun) {
            rerun = false;
            triggerRefresh();
          }
        });
    };
    // Seed the last-seen stat so an unrelated first dir event is a no-op.
    lastCredStat = credFileSig();
    watcher = watch(watchDir, (eventType, filename) => {
      // `filename` can be null on some platforms/events. Treat null as
      // "unknown — reload anyway" instead of dropping it, so a revocation
      // (rotate-because-leaked) is never missed: fail-safe, not fail-stale.
      // The handler's stat-guard keeps a spurious reload a cheap no-op and
      // prevents an audit-write feedback loop on null-filename platforms.
      if (filename !== null && filename !== credBasename) return;
      if (eventType !== "change" && eventType !== "rename") return;
      triggerRefresh();
    });
    // Don't let the watcher keep the event loop alive on its own.
    watcher.unref?.();
    logger.info(`Watching ${watchDir} for credential rotations (${credBasename})`);
  }

  // 12. §D.3 first-run UX lines. Computed here — loadResult, envOverrides, and
  //     credentialStore.size are all settled post-loadAll and the parent makes
  //     no further store mutations before the transport owner emits these. The
  //     owner writes them to STDERR (stdout is the MCP transport) after connect.
  const summaryLines = buildServeSummary({
    loadResult,
    envOverrideNames: Object.keys(envOverrides),
    storeSize: credentialStore.size,
    suppressMigrateNudge: ["1", "true"].includes(
      process.env["KUZO_NO_MIGRATE_NUDGE"] ?? "",
    ),
  });

  // 13. Shared-resource teardown. Order is pinned by invariant 4: watcher first
  //     (stop the rotation watch before the store goes away), then loader
  //     children, then registry, then credentialStore.close() LAST. Does NOT
  //     close any per-session MCP `Server` — each transport owner closes its
  //     own (stdio: runServer below; HTTP: @kuzo-mcp/server-http per session).
  const shutdown = async (): Promise<void> => {
    watcher?.close();
    await loader.shutdownAll();
    await registry.shutdownAll();
    credentialStore.close();
  };

  return { registry, logger, shutdown, summaryLines };
}

// ---------------------------------------------------------------------------
// runServer — stdio entry (boot once, serve one stdio session)
// ---------------------------------------------------------------------------

/**
 * Boots Kuzo and serves a single MCP session over stdio — the shipped default
 * transport. Thin wrapper over `bootKuzo()` + `buildMcpServer()`: behaviorally
 * identical to the pre-seam monolithic `runServer` (Phase 4a §4.1), proven by
 * the 2.5e install-parity test which boots this path directly.
 */
export async function runServer(options: RunServerOptions = {}): Promise<void> {
  const handle = await bootKuzo(options);
  const server = buildMcpServer(handle.registry, handle.logger);

  // Tear down shared boot resources, then this session's server. Inside
  // handle.shutdown, credentialStore.close() runs AFTER loader.shutdownAll()
  // (invariant 4); server.close() runs last — exactly as the pre-seam path did.
  attachShutdownHandlers(handle.logger, async () => {
    await handle.shutdown();
    await server.close();
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  handle.logger.info("Kuzo MCP Server running on stdio");

  for (const line of handle.summaryLines) {
    process.stderr.write(`${line}\n`);
  }
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
