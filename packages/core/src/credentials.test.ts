/**
 * credentials.ts — DefaultCredentialBroker contract tests.
 *
 * Phase 2.6 Theme 6: covers spec §C.4 (registerClientFactory + third-party
 * factory flow) and §C.5 (child-side shutdown scrub). The broker is the
 * surface plugins touch through `PluginContext.credentials`; these tests
 * lock the manifest-contract enforcement, first-party override rejection,
 * idempotent re-registration, and shutdown invariants.
 *
 * No I/O — the broker holds only in-memory state. Run via
 * `pnpm test:credentials`.
 */

import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";

import type {
  CredentialCapability,
  PluginLogger,
} from "@kuzo-mcp/types";

import type { AuditEvent, AuditLogger } from "./audit.js";
import { DefaultCredentialBroker } from "./credentials.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function captureLogger(): PluginLogger & { calls: Array<{ level: string; message: string }> } {
  const calls: Array<{ level: string; message: string }> = [];
  return {
    calls,
    debug: (msg) => calls.push({ level: "debug", message: msg }),
    info: (msg) => calls.push({ level: "info", message: msg }),
    warn: (msg) => calls.push({ level: "warn", message: msg }),
    error: (msg) => calls.push({ level: "error", message: msg }),
  };
}

function captureAudit(): AuditLogger & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    log(event: Omit<AuditEvent, "timestamp">) {
      // No `as AuditEvent` cast — the structural spread already satisfies
      // the type; the cast would mask new required fields on AuditEvent.
      events.push({ timestamp: new Date().toISOString(), ...event });
    },
    query() {
      return events;
    },
  };
}

interface MakeBrokerOpts {
  pluginName?: string;
  config?: Map<string, string>;
  capabilities?: CredentialCapability[];
}

function makeBroker(opts: MakeBrokerOpts = {}) {
  const logger = captureLogger();
  const auditLogger = captureAudit();
  const broker = new DefaultCredentialBroker({
    pluginName: opts.pluginName ?? "test-plugin",
    config: opts.config ?? new Map(),
    capabilities: opts.capabilities ?? [],
    logger,
    auditLogger,
  });
  return { broker, logger, auditLogger };
}

// ─── §C.4 — registerClientFactory ──────────────────────────────────────────

test("registerClientFactory rejects first-party 'github' override", (_t: TestContext) => {
  const { broker } = makeBroker();
  assert.throws(
    () => broker.registerClientFactory("github", () => ({ stub: true })),
    /cannot override first-party client factory for "github"/,
  );
});

test("registerClientFactory rejects first-party 'jira' override", (_t: TestContext) => {
  const { broker } = makeBroker();
  assert.throws(
    () => broker.registerClientFactory("jira", () => ({ stub: true })),
    /cannot override first-party client factory for "jira"/,
  );
});

test("registerClientFactory accepts a fresh third-party service name", (_t: TestContext) => {
  const { broker } = makeBroker();
  // Should not throw — first call is the canonical registration.
  broker.registerClientFactory("appletv", () => ({ kind: "appletv-client" }));
  const client = broker.getClient<{ kind: string }>("appletv");
  assert.deepEqual(client, { kind: "appletv-client" });
});

test("registerClientFactory is idempotent for the same service (no-op on re-register)", (_t: TestContext) => {
  const { broker } = makeBroker();
  broker.registerClientFactory("appletv", () => ({ generation: 1 }));
  // Second registration MUST be silently dropped — the spec mandates
  // idempotency so a plugin can retry initialize() without crashing.
  broker.registerClientFactory("appletv", () => ({ generation: 2 }));
  const client = broker.getClient<{ generation: number }>("appletv");
  assert.deepEqual(client, { generation: 1 }, "first registration wins");
});

test("getClient on a third-party factory skips the first-party env-list check", (_t: TestContext) => {
  // No CredentialCapability declared at all — the third-party factory is
  // trusted to handle missing credentials itself by returning undefined.
  // Spec §C.4: "The plugin must declare access: 'client' ... otherwise
  // getClient<T>('...') will fail anyway." The broker delegates the
  // declaration check to the factory for non-first-party services.
  const config = new Map<string, string>([["APPLETV_PAIRING_TOKEN", "abc123"]]);
  const { broker } = makeBroker({ config });
  broker.registerClientFactory("appletv", (cfg) => {
    const token = cfg.get("APPLETV_PAIRING_TOKEN");
    if (!token) return undefined;
    return { authedAs: token };
  });
  assert.deepEqual(broker.getClient("appletv"), { authedAs: "abc123" });
});

test("getClient on an unknown service warns and returns undefined", (_t: TestContext) => {
  const { broker, logger } = makeBroker();
  assert.equal(broker.getClient("ghost-service"), undefined);
  const warns = logger.calls.filter((c) => c.level === "warn");
  assert.equal(warns.length, 1);
  assert.match(warns[0]!.message, /unknown service "ghost-service"/);
});

test("getClient first-party still enforces access:client on every declared env", (_t: TestContext) => {
  // GitHub requires GITHUB_TOKEN with access:"client". If the manifest
  // declares it raw instead, getClient must refuse.
  const config = new Map<string, string>([["GITHUB_TOKEN", "ghp_xxx"]]);
  const capabilities: CredentialCapability[] = [
    {
      kind: "credentials",
      env: "GITHUB_TOKEN",
      access: "raw",
      reason: "raw not client",
    },
  ];
  const { broker, logger } = makeBroker({ config, capabilities });
  const client = broker.getClient("github");
  assert.equal(client, undefined);
  const warns = logger.calls.filter((c) => c.level === "warn");
  assert.ok(
    warns.some((w) => /did not declare access: "client"/.test(w.message)),
    "should warn about missing access:client declaration",
  );
});

test("getClient first-party with full declaration emits credential.client_created", (_t: TestContext) => {
  const config = new Map<string, string>([["GITHUB_TOKEN", "ghp_xxx"]]);
  const capabilities: CredentialCapability[] = [
    {
      kind: "credentials",
      env: "GITHUB_TOKEN",
      access: "client",
      reason: "github",
    },
  ];
  const { broker, auditLogger } = makeBroker({ config, capabilities });
  const client = broker.getClient("github");
  assert.notEqual(client, undefined);
  const created = auditLogger.events.filter(
    (e) => e.action === "credential.client_created",
  );
  assert.equal(created.length, 1);
  assert.equal(created[0]!.details["service"], "github");
});

test("getClient caches the third-party client per service", (_t: TestContext) => {
  const { broker } = makeBroker();
  let calls = 0;
  broker.registerClientFactory("appletv", () => {
    calls += 1;
    return { id: calls };
  });
  const first = broker.getClient<{ id: number }>("appletv");
  const second = broker.getClient<{ id: number }>("appletv");
  assert.deepEqual(first, { id: 1 });
  assert.equal(second, first, "second call returns the cached instance");
  assert.equal(calls, 1, "factory invoked exactly once");
});

test("constructor REJECTS a clientFactories override that contains a first-party name (round-1 Sec A1)", (_t: TestContext) => {
  // Defense-in-depth complement to the runtime registerClientFactory gate:
  // if a caller ever wires the `clientFactories` option to non-test code,
  // attempting to launder a malicious "github" factory through it must
  // throw at construction — NOT silently install. Locks both reserved
  // names independently so removing either from the loop reads as a
  // test failure.
  const logger = captureLogger();
  const evil: ReadonlyMap<string, (config: Map<string, string>, log: PluginLogger) => unknown> = new Map([
    ["github", () => ({ malicious: true })],
  ]);
  assert.throws(
    () =>
      new DefaultCredentialBroker({
        pluginName: "attacker",
        config: new Map(),
        capabilities: [],
        logger,
        clientFactories: evil,
      }),
    /cannot redefine first-party service "github"/,
  );
  const evilJira: ReadonlyMap<string, (config: Map<string, string>, log: PluginLogger) => unknown> = new Map([
    ["jira", () => ({ malicious: true })],
  ]);
  assert.throws(
    () =>
      new DefaultCredentialBroker({
        pluginName: "attacker",
        config: new Map(),
        capabilities: [],
        logger,
        clientFactories: evilJira,
      }),
    /cannot redefine first-party service "jira"/,
  );
});

test("clientFactories override (test seam) replaces the first-party defaults", (_t: TestContext) => {
  // The constructor option lets tests inject a clean factory map. With an
  // empty override, github/jira are gone — and registering them succeeds
  // because the FIRST_PARTY_FACTORIES reservation key set is the source
  // of truth for the override gate (not the per-instance map).
  const logger = captureLogger();
  const broker = new DefaultCredentialBroker({
    pluginName: "iso",
    config: new Map(),
    capabilities: [],
    logger,
    clientFactories: new Map(),
  });
  // 'github' is STILL in the reservation set — override forbidden.
  assert.throws(() => broker.registerClientFactory("github", () => ({})));
  // 'never-seen' is fresh and can be registered.
  broker.registerClientFactory("never-seen", () => ({ ok: true }));
  assert.deepEqual(broker.getClient("never-seen"), { ok: true });
  // getClient on a first-party name still returns undefined here — the
  // override map dropped github's factory.
  assert.equal(broker.getClient("github"), undefined);
});

// ─── §C.5 — shutdown ────────────────────────────────────────────────────────

test("shutdown() drops config + factories + cached clients", (_t: TestContext) => {
  const config = new Map<string, string>([["FOO", "bar"]]);
  const { broker } = makeBroker({ config });
  broker.registerClientFactory("appletv", () => ({ live: true }));
  // Prime the cache by calling getClient once.
  assert.deepEqual(broker.getClient("appletv"), { live: true });
  // hasCredential proves config has FOO.
  assert.equal(broker.hasCredential("FOO"), true);

  broker.shutdown();

  // After shutdown the config Map is empty.
  assert.equal(broker.hasCredential("FOO"), false);
  // Registered factories are wiped — getClient now reports unknown.
  assert.equal(broker.getClient("appletv"), undefined);
  // Cached client reference is gone too (the cache map was cleared).
});

test("shutdown() is idempotent — second call doesn't throw or revive state", (_t: TestContext) => {
  const { broker } = makeBroker();
  broker.shutdown();
  // Calling again on an already-empty broker is a no-op; no exception.
  broker.shutdown();
  // Re-confirm post-state.
  assert.equal(broker.getClient("github"), undefined);
});

test("shutdown() does not emit an audit event itself", (_t: TestContext) => {
  // Spec §C.5: the child broker drops local state silently. The parent
  // emits `credential.store_locked` from `EncryptedCredentialStore.close()`;
  // the child does NOT mirror it (the child never held the master key).
  const { broker, auditLogger } = makeBroker();
  broker.shutdown();
  assert.equal(auditLogger.events.length, 0);
});
