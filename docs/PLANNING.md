# Kuzo MCP — Architecture Specification

> Plugin-based "everything MCP" — one personal MCP server, infinite integrations.

**Status:** Planning  
**Last Updated:** 2026-04-09  
**Owner:** Sean Tokuzo

---

## Table of Contents

- [Vision](#vision)
- [Current State](#current-state)
- [Target Architecture](#target-architecture)
  - [Core System](#core-system)
  - [Plugin Interface](#plugin-interface)
  - [Plugin Context](#plugin-context)
  - [Directory Structure](#directory-structure)
- [Migration Plan](#migration-plan)
  - [Phase 1: Core Infrastructure](#phase-1-core-infrastructure)
  - [Phase 2: Convert Existing Code to Plugins](#phase-2-convert-existing-code-to-plugins)
  - [Phase 2.5: Plugin Security & Open-Source Readiness](#phase-25-plugin-security--open-source-readiness)
  - [Phase 3: Expand GitHub Plugin](#phase-3-expand-github-plugin)
  - [Phase 4: New Integrations](#phase-4-new-integrations)
  - [Phase 5: Cross-Plugin Workflows](#phase-5-cross-plugin-workflows)
- [GitHub Plugin Gap Analysis](#github-plugin-gap-analysis)
- [Tech Stack](#tech-stack)
- [Design Principles](#design-principles)
- [Configuration](#configuration)
- [Anti-Patterns](#anti-patterns)

---

## Vision

Kuzo MCP is being rebuilt as a **plugin-based "everything MCP"** — a single personal MCP server where each integration (GitHub, Jira, Calendar, SMS, Browser, etc.) is a self-contained plugin.

The core handles MCP protocol, plugin lifecycle, config, and logging. Plugins register tools, resources, and optionally CLI commands. You enable what you need, disable what you don't, and the server only loads what's active.

**Why plugin architecture?**

- The current monolithic `server.ts` is a 920-line god file with all tool definitions, handlers, Zod schemas, and business logic jammed together
- Adding a new integration means touching the server core — that doesn't scale
- Each service (GitHub, Jira) is already a natural boundary — the plugin model just formalizes it
- Plugins can be developed, tested, and versioned independently
- Users can enable only the integrations they actually use

---

## Current State

### What Exists Today

| Component | Location | Description |
|-----------|----------|-------------|
| MCP Server | `src/mcp/server.ts` | Monolithic — all tool defs, handlers, schemas, description generation in one 920-line file |
| GitHub Service | `src/services/github.ts` | Octokit wrapper — PRs, repos, reviews, branches, diffs, file content. Singleton pattern |
| Jira Service | `src/services/jira.ts` | Atlassian Cloud REST v3 — tickets, transitions, subtasks, comments, search. Singleton pattern |
| Git Context | `src/services/git.ts` | Local git detection — repo, branch, status, commits via `execSync` |
| Config | `src/utils/config.ts` | dotenv-based config with validation. Flat `Config` interface covering all services |
| Logger | `src/utils/logger.ts` | chalk-based logger with levels. Global singleton |
| CLI | `src/cli/` | Commander-based interactive CLI — PR, repo, review, jira, config commands |
| Types | `src/types/index.ts` | All types in one 420-line file — GitHub, MCP, CLI, Webhook, Jira, PR Review |
| Entry | `src/index.ts` | Exports for programmatic usage |

### Current File Tree

```
src/
├── index.ts                  # Package entry, exports
├── server.ts                 # Express webhook server (unused?)
├── mcp/
│   └── server.ts             # MCP server (monolithic)
├── services/
│   ├── git.ts                # Git context detection
│   ├── github.ts             # GitHub API (Octokit)
│   └── jira.ts               # Jira API (REST v3)
├── cli/
│   ├── index.ts              # Commander program definition
│   ├── commands/
│   │   ├── index.ts
│   │   ├── config.ts
│   │   ├── jira.ts
│   │   ├── pr.ts
│   │   ├── repo.ts
│   │   └── review.ts
│   └── ui/
│       ├── index.ts
│       ├── display.ts
│       └── messages.ts
├── types/
│   └── index.ts              # All types (420 lines)
└── utils/
    ├── config.ts             # dotenv config + validation
    └── logger.ts             # Chalk logger
```

### Current MCP Tools (6 total)

| Tool | Description |
|------|-------------|
| `get_git_context` | Detect repo, branch, status from local git |
| `create_pull_request` | Create PR with auto-detected repo/branch |
| `update_pull_request` | Update PR title/description |
| `get_pull_request` | Get PR details by number |
| `list_pull_requests` | List PRs for a repo |
| `find_pr_for_branch` | Find PR associated with a branch |

### Current MCP Resources (1 total)

| Resource | Description |
|----------|-------------|
| `git://context` | JSON representation of current git state |

### Problems With Current Architecture

1. **Monolithic server** — adding tools means editing a single massive file
2. **No plugin boundary** — GitHub, Jira, and git-context are conceptually separate but not structurally separate
3. **Jira not exposed via MCP** — JiraService exists but only the CLI uses it; no MCP tools for Jira
4. **Singleton services** — `getGitHubService()` / `getJiraService()` are global singletons that make testing hard
5. **Config is flat** — one `Config` object covers all services; no per-plugin config validation
6. **Types in one file** — 420 lines of types for every domain in one file
7. **No tool-level code splitting** — all 6 tool handlers live inline in server.ts

---

## Target Architecture

### Core System

The core system is thin. It handles:

1. **MCP Protocol** — Server setup, transport, request routing
2. **Plugin Registry** — Track loaded plugins, their tools, and resources
3. **Plugin Loader** — Discover plugins, validate config, call `initialize()`
4. **Config Management** — Load env vars, validate per-plugin requirements
5. **Logging** — Structured logging with plugin-scoped prefixes

The core knows nothing about GitHub, Jira, or any specific integration. It only knows how to load plugins and route tool calls to them.

### Plugin Interface

```typescript
interface KuzoPlugin {
  /** Unique plugin identifier (e.g., "github", "jira") */
  name: string;

  /** Human-readable description */
  description: string;

  /** Semver version string */
  version: string;

  /** Environment variables this plugin requires to function */
  requiredConfig?: string[];

  /** Environment variables this plugin can optionally use */
  optionalConfig?: string[];

  /**
   * Called once when the plugin is loaded.
   * Use this to initialize API clients, validate connections, etc.
   */
  initialize(context: PluginContext): Promise<void>;

  /**
   * Called when the server is shutting down.
   * Clean up connections, flush buffers, etc.
   */
  shutdown?(): Promise<void>;

  /** MCP tools this plugin exposes */
  tools: ToolDefinition[];

  /** MCP resources this plugin exposes (optional) */
  resources?: ResourceDefinition[];
}
```

### Plugin Context

Each plugin receives a `PluginContext` at initialization — this is its window into the core system. No global imports, no singletons.

```typescript
interface PluginContext {
  /** Config values relevant to this plugin (from env vars) */
  config: Map<string, string>;

  /** Plugin-scoped logger (prefixed with plugin name) */
  logger: Logger;

  /**
   * Call another registered tool by its unique tool name.
   * This is the ONLY way plugins communicate — no direct imports.
   */
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}
```

### Tool Definition

```typescript
interface ToolDefinition {
  /** Tool name — must be globally unique (e.g., "github_create_pr") */
  name: string;

  /** Description shown to the LLM */
  description: string;

  /** Zod schema for input validation */
  inputSchema: z.ZodType<any>;

  /** The handler function */
  handler: (args: any, context: PluginContext) => Promise<any>;
}
```

### Resource Definition

```typescript
interface ResourceDefinition {
  /** Resource URI (e.g., "git://context") */
  uri: string;

  /** Human-readable name */
  name: string;

  /** Description */
  description: string;

  /** MIME type */
  mimeType: string;

  /** Handler that returns resource content */
  handler: (context: PluginContext) => Promise<string>;
}
```

### Directory Structure (Target)

```
src/
├── core/
│   ├── server.ts              # MCP server — protocol only, routes to registry
│   ├── registry.ts            # Plugin registry — stores plugins, tools, resources
│   ├── loader.ts              # Plugin discovery — finds, validates, loads plugins
│   ├── config.ts              # Config management — env vars, per-plugin validation
│   └── logger.ts              # Structured logging with plugin-scoped prefixes
├── plugins/
│   ├── types.ts               # KuzoPlugin, PluginContext, ToolDefinition, ResourceDefinition
│   ├── git-context/           # Git context detection (core utility plugin)
│   │   ├── index.ts           # Plugin entry — exports KuzoPlugin
│   │   └── tools/
│   │       └── context.ts     # get_git_context tool
│   ├── github/                # GitHub integration
│   │   ├── index.ts           # Plugin entry — exports KuzoPlugin
│   │   ├── client.ts          # Octokit wrapper (extracted from GitHubService)
│   │   └── tools/
│   │       ├── pulls.ts       # create, update, get, list, find, merge PRs
│   │       ├── issues.ts      # create, update, list, search issues
│   │       ├── repos.ts       # create, update, get, list repos
│   │       ├── releases.ts    # create, list, get, update, delete releases
│   │       ├── actions.ts     # workflow runs, triggers, artifacts
│   │       ├── labels.ts      # create, list, add/remove labels
│   │       ├── reviews.ts     # get, submit, comment on reviews
│   │       └── branches.ts    # list, protect, create branches
│   ├── jira/                  # Jira integration
│   │   ├── index.ts           # Plugin entry
│   │   ├── client.ts          # REST API client (extracted from JiraService)
│   │   └── tools/
│   │       ├── tickets.ts     # get, update, search, my-tickets
│   │       ├── transitions.ts # move, get transitions
│   │       ├── subtasks.ts    # create, list subtasks
│   │       └── comments.ts    # add, list comments
│   ├── confluence/            # (Phase 4)
│   │   ├── index.ts
│   │   ├── client.ts
│   │   └── tools/
│   ├── discord/               # (Phase 4)
│   │   ├── index.ts
│   │   ├── client.ts
│   │   └── tools/
│   ├── calendar/              # (Phase 4)
│   │   ├── index.ts
│   │   ├── client.ts
│   │   └── tools/
│   ├── sms/                   # (Phase 4)
│   │   ├── index.ts
│   │   ├── client.ts
│   │   └── tools/
│   ├── browser/               # (Phase 4)
│   │   ├── index.ts
│   │   └── tools/
│   ├── notion/                # (Phase 4)
│   │   ├── index.ts
│   │   ├── client.ts
│   │   └── tools/
│   └── slack/                 # (Phase 4)
│       ├── index.ts
│       ├── client.ts
│       └── tools/
├── cli/                       # CLI — kept but uses plugin registry for tool discovery
│   ├── index.ts
│   ├── commands/
│   └── ui/
└── index.ts                   # Package entry
```

---

## Migration Plan

### Phase 1: Core Infrastructure

**Goal:** Build the plugin system so everything else can plug into it.

**Deliverables:**

| File | Purpose |
|------|---------|
| `src/plugins/types.ts` | `KuzoPlugin`, `PluginContext`, `ToolDefinition`, `ResourceDefinition` interfaces |
| `src/core/registry.ts` | `PluginRegistry` — register plugins, look up tools/resources by name |
| `src/core/loader.ts` | `PluginLoader` — discover plugins from `src/plugins/*/index.ts`, validate required config, call `initialize()` |
| `src/core/config.ts` | Refactored config — per-plugin env var mapping, validation returns plugin-specific errors |
| `src/core/logger.ts` | Logger with `createPluginLogger(pluginName)` that prefixes all output |
| `src/core/server.ts` | New MCP server — delegates `ListTools` / `CallTool` / `ListResources` / `ReadResource` to registry |
| `kuzo.config.ts` | Plugin enable/disable configuration |

**Registry Design:**

```typescript
class PluginRegistry {
  private plugins: Map<string, KuzoPlugin>;
  private toolMap: Map<string, { plugin: KuzoPlugin; tool: ToolDefinition }>;
  private resourceMap: Map<string, { plugin: KuzoPlugin; resource: ResourceDefinition }>;

  register(plugin: KuzoPlugin): void;
  getPlugin(name: string): KuzoPlugin | undefined;
  getAllTools(): ToolDefinition[];
  findTool(name: string): { plugin: KuzoPlugin; tool: ToolDefinition } | undefined;
  findResource(uri: string): { plugin: KuzoPlugin; resource: ResourceDefinition } | undefined;
  callTool(pluginName: string, toolName: string, args: any): Promise<any>;
}
```

**Loader Design:**

```typescript
class PluginLoader {
  constructor(registry: PluginRegistry, config: ConfigManager);

  /**
   * Scan plugins directory, filter by kuzo.config.ts,
   * validate required env vars, initialize in dependency order.
   */
  async loadAll(): Promise<LoadResult>;

  /**
   * Load a single plugin by name.
   * Returns error details if config is missing.
   */
  async loadPlugin(name: string): Promise<LoadResult>;
}

interface LoadResult {
  loaded: string[];
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; error: string }>;
}
```

**kuzo.config.ts Format:**

```typescript
// kuzo.config.ts
export default {
  plugins: {
    "git-context": { enabled: true },
    "github": { enabled: true },
    "jira": { enabled: true },
    "confluence": { enabled: false },
    "discord": { enabled: false },
    "calendar": { enabled: false },
    "sms": { enabled: false },
    "browser": { enabled: false },
    "notion": { enabled: false },
    "slack": { enabled: false },
  },
};
```

**Acceptance criteria:**
- [ ] Plugin interface defined with types
- [ ] Registry can register plugins and look up tools/resources
- [ ] Loader discovers plugins, validates config, calls `initialize()`
- [ ] Server delegates all tool/resource calls through registry
- [ ] Plugins that fail config validation are skipped with a clear error, not crash the server
- [ ] `kuzo.config.ts` controls which plugins load

---

### Phase 2: Convert Existing Code to Plugins

**Goal:** Extract current functionality into plugin format. Zero feature regression.

**git-context plugin:**

| Source | Destination |
|--------|-------------|
| `src/services/git.ts` (all functions) | `src/plugins/git-context/tools/context.ts` |
| `get_git_context` tool from `server.ts` | `src/plugins/git-context/tools/context.ts` |
| `git://context` resource from `server.ts` | `src/plugins/git-context/index.ts` |

- `requiredConfig: []` (no env vars needed — reads local git)
- Exposes 1 tool: `get_git_context`
- Exposes 1 resource: `git://context`

**github plugin:**

| Source | Destination |
|--------|-------------|
| `src/services/github.ts` (class) | `src/plugins/github/client.ts` |
| PR tools from `server.ts` | `src/plugins/github/tools/pulls.ts` |
| PR review methods from `github.ts` | `src/plugins/github/tools/reviews.ts` |
| Repo methods from `github.ts` | `src/plugins/github/tools/repos.ts` |
| PR description generator from `server.ts` | `src/plugins/github/tools/pulls.ts` (private helper) |
| GitHub types from `types/index.ts` | `src/plugins/github/types.ts` |

- `requiredConfig: ["GITHUB_TOKEN"]`
- `optionalConfig: ["GITHUB_USERNAME", "GITHUB_ORG"]`
- Phase 2 tools: `create_pull_request`, `update_pull_request`, `get_pull_request`, `list_pull_requests`, `find_pr_for_branch`, `get_pr_files`, `get_pr_reviews`, `submit_review`, `create_repository`, `get_repo_info`, `list_my_repos`, `update_repository`

**jira plugin:**

| Source | Destination |
|--------|-------------|
| `src/services/jira.ts` (class) | `src/plugins/jira/client.ts` |
| Jira types from `types/index.ts` | `src/plugins/jira/types.ts` |
| New MCP tool handlers | `src/plugins/jira/tools/*.ts` |

- `requiredConfig: ["JIRA_HOST", "JIRA_EMAIL", "JIRA_API_TOKEN"]`
- Tools (new MCP exposure of existing service methods): `get_ticket`, `search_tickets`, `get_my_tickets`, `move_ticket`, `get_transitions`, `create_subtask`, `get_subtasks`, `update_ticket`, `add_comment`, `get_comments`, `get_my_code_reviews`

**Acceptance criteria:**
- [ ] All 6 existing MCP tools work identically through the plugin system
- [ ] `git://context` resource works through the plugin system
- [ ] GitHub service methods all accessible as MCP tools (not just the 6 PR tools)
- [ ] Jira service methods exposed as MCP tools for the first time
- [ ] Old `src/mcp/server.ts`, `src/services/github.ts`, `src/services/jira.ts` deleted
- [ ] CLI still works (updated to use plugin registry or direct plugin imports)
- [ ] Types split into per-plugin type files

---

### Phase 2.5: Plugin Security & Open-Source Readiness

**Goal:** Transform Kuzo MCP from a personal trusted-plugins architecture into a security-hardened platform capable of loading untrusted third-party plugins. This unlocks the open-source ecosystem vision — a single centralized MCP server loading plugins, replacing the wasteful server-per-integration pattern that dominates the current MCP ecosystem.

**Status:** Research + design complete (2026-04-12). Phase 2.5a implementation complete (PR #11). See [`docs/SECURITY.md`](./SECURITY.md) for the full design spec.

**Why this phase exists:** The current MCP ecosystem is architecturally inefficient. Every integration ships as its own Node process with duplicated protocol code, lifecycle management, and zero composition. A centralized plugin-based server is strictly better — but the only blocker to open-sourcing it is security: how do you safely load plugins from untrusted sources?

Phase 1-2 build the plugin architecture under a **trusted plugin** assumption (all plugins authored by the project owner). Phase 2.5 earns the right to drop that assumption. Our own first-party plugins (github, jira, git-context, and future ones) will be published as standalone npm packages — we eat our own dogfood on every security feature before anyone else touches it.

#### Implementation Sub-Phases

| Sub-Phase | Scope | Status | Dependencies |
|-----------|-------|--------|-------------|
| **2.5a** | Manifest + hardening | **Complete** (PR #11) | Phase 2 |
| **2.5b** | Credential broker | **Complete** (PR #12) | 2.5a |
| **2.5c** | Consent flow + audit | **Complete** (PR #13) | 2.5b |
| **2.5d** | Process isolation | **Complete** | 2.5a |
| **2.5e** | Supply chain (npm publish + provenance) | Next up | 2.5d |

**2.5a — Manifest + Hardening** (complete)

Discriminated union plugin interfaces (`KuzoPluginV1`/`V2` with `permissionModel` discriminant), 5 capability types, scoped `callTool`, prototype freezing, `process.exit` guard, shutdown timeouts, collision message sanitization. All 3 plugins migrated to V2. See PR #11.

**2.5b — Credential Broker**

`CredentialBroker` interface + `DefaultCredentialBroker` implementation. Hybrid model: pre-authenticated clients for known services (GitHub → Octokit, Jira → JiraClient), scoped `authenticatedFetch` for HTTP APIs, raw escape hatch with audit logging. Migrate plugins off `context.config.get()` to `context.credentials.getClient()`. Deprecation warnings on `context.config` usage. See `docs/SECURITY.md` §6 for interface design.

**2.5c — Consent Flow + Audit**

`kuzo consent` CLI command with interactive capability review UI. Consent storage at `~/.kuzo/consent.json`. Trust overrides via `KUZO_TRUST_PLUGINS` env var (for MCP server startup where stdout is transport). Structured audit log for capability usage events. Loader refuses unconsented plugins unless trust override is set. Per-tool `callTool` granularity enforcement (deferred from 2.5a). See `docs/SECURITY.md` §9.

**2.5d — Process Isolation**

Child process per plugin via `child_process.fork()`. Each child gets only its declared env vars. JSON-RPC 2.0 envelope over Node IPC (`process.send`/`on('message')`). Core builds `ToolDefinition` proxy stubs from child's startup manifest.

Key implementation decisions:
- **IPC protocol:** JSON-RPC 2.0 over `process.send()`. Not MCP SDK `Transport` (too coupled to MCP session semantics). Core keeps `Map<id, {resolve, reject, timer}>` for pending calls.
- **Plugin host:** Minimal `plugin-host.ts` — dynamic imports plugin, builds IPC-backed `PluginContext`, reports tool manifest on `ready` message, handles tool invocations.
- **Lazy spawn:** Register tool names from manifests at startup (zero cost). Spawn child on first `callTool`. Cache for subsequent calls. First-call latency: ~200ms (invisible next to API round-trips).
- **Startup cost:** ~150-250ms per plugin, ~500-750ms for 3 in parallel. ~40-50MB RSS per child. Noise on a dev machine.
- **Node Permission Model:** `--permission --allow-fs-read=/path` per child as defense-in-depth. Experimental, no network restrictions, 3 CVEs in Jan 2026 — not sole protection.
- **Error handling:** 4 modes: (a) clean shutdown via IPC + 5s timeout + SIGTERM + SIGKILL, (b) crash → restart with exponential backoff (0/500ms/2s/8s/30s cap, reset after 60s stable), (c) OOM → same as crash + `--max-old-space-size=256` per child, (d) hung → 30s heartbeat ping, kill if no pong.
- **Credential injection:** `fork({env: scopedVars})` replaces entire env. Must include `PATH`, `LANG`, `TERM`, `NODE_ENV`. Omit `HOME` or sandbox it.
- **Max restarts:** 5 in 5 minutes, then mark plugin `degraded` and surface in MCP responses.

See `docs/SECURITY.md` §3 for architecture diagram.

**2.5e — Supply Chain (npm publish + provenance)**

Publish first-party plugins as standalone npm packages. `kuzo plugins install/update/rollback` CLI commands with Sigstore provenance verification.

Key implementation decisions:
- **npm provenance:** GitHub Actions Trusted Publishing workflow. `npm publish --provenance` flag. Two attestations per publish: npm publish attestation + SLSA provenance. Still requires `NPM_TOKEN` secret (no tokenless yet).
- **Verification:** `@sigstore/verify` to programmatically check provenance BEFORE `npm install`. Decode SLSA payload, verify `externalParameters.workflow.repository` matches allowed source org. Reject packages without provenance (override with `--trust-unsigned`).
- **Monorepo restructure:** Current `src/plugins/` → Turborepo monorepo with `packages/` directory. Each plugin becomes its own npm package. `@changesets/cli` for version coordination and changelogs.

```
packages/
  types/              → @kuzo-mcp/types (peer dep for all plugins)
  core/               → kuzo-mcp (the server + loader + CLI)
  plugin-github/      → kuzo-mcp-plugin-github
  plugin-jira/        → kuzo-mcp-plugin-jira
  plugin-git-context/ → kuzo-mcp-plugin-git-context
```

- **Plugin package structure:** ESM, `"exports"` field, peer dep on `@kuzo-mcp/types`. `package.json` includes `kuzoPlugin` metadata field for capability summary.
- **Version coordination:** Peer dep ranges (`^2.0.0`). Major type changes → new peer dep major. Loader supports V1+V2 simultaneously (already built). Changesets handles "which packages changed" in monorepo.
- **Install flow:** `kuzo plugins install kuzo-mcp-plugin-github` → npm resolve → verify provenance → npm install into `~/.kuzo/plugins/` → parse manifest → consent flow → register in config.
- **Install location:** `~/.kuzo/plugins/` with managed `node_modules` (isolated from core server deps). `npm install --prefix ~/.kuzo/plugins`.
- **Provenance strictness:** First-party: pin to `github.com/seantokuzo/*`. Third-party: any repo with valid Sigstore provenance.
- **Update model:** `kuzo plugins update` — manual, shows changelog + capability diff, requires re-consent if new capabilities. `kuzo plugins rollback` for instant revert. Never auto-update.

#### Success Criteria

- [ ] A malicious third-party plugin cannot access other plugins' credentials
- [ ] A malicious plugin cannot make unauthorized API calls on behalf of other plugins
- [ ] Plugins cannot escape their declared filesystem/network sandbox
- [ ] Users have visibility into every capability each plugin requests before installing
- [ ] Plugin authors have a clear, documented path for declaring required permissions
- [ ] Existing Phase 2 plugins are migrated without functionality loss
- [ ] First-party plugins published as standalone npm packages with Sigstore provenance
- [ ] Threat model doc is public and reviewable

#### Decisions Made

| Decision | Date | Rationale |
|----------|------|-----------|
| Child process per plugin (not workers/vm/WASM) | 2026-04-12 | OS-level isolation, IPC is cheap vs API latency, production-proven (VS Code, Chrome). Workers share process, vm is repeatedly broken, WASM kills DX. |
| Discriminated union for plugin manifests (V1/V2) | 2026-04-12 | Separate versioned interfaces > optional field accumulation. Chrome MV2→V3 and Terraform protocol v5→v6 prior art. Clean evolution for V3+. |
| Hybrid credential broker | 2026-04-12 | Pre-auth clients for known services (safest) + scoped authenticated fetch + raw escape hatch. Single approach can't cover all cases. |
| npm as plugin registry | 2026-04-12 | Sigstore provenance free + built-in. Zero hosting burden. `kuzo-mcp-plugin-*` naming convention (unscoped). |
| Monorepo with Turborepo | 2026-04-12 | Atomic cross-cutting changes. Single CI pipeline. Changesets for version coordination. Already have plugins in `src/plugins/`. |
| Own plugins as standalone npm packages | 2026-04-12 | Eat our own dogfood on the entire plugin ecosystem. Validates install/verify/consent flow before third-party plugins exist. |

---

### Phase 2.6: Distribution & Packaging

**Goal:** Make Kuzo MCP installable and configurable for non-author users across all major MCP clients. Ship the `kuzo setup` command that makes first-time setup a 3-command experience.

**Status:** Planned. Depends on Phase 2.5e (supply chain) for npm packaging.

#### Distribution Tiers

| Tier | Method | Audience | Priority |
|------|--------|----------|----------|
| **1** | npm (`npx kuzo-mcp` / `npm install -g kuzo-mcp`) | Developers | Ship with open-source launch |
| **1** | `.mcp.json` repo template | Teams | Ship alongside Tier 1 |
| **2** | Homebrew formula | macOS devs | After initial users |
| **3** | Docker image | Security-conscious / CI | After initial users |

#### MCP Client Registration

Each client has its own config format and location. `kuzo setup` handles all of them.

| Client | Config Location | Root Key | One-liner |
|--------|----------------|----------|-----------|
| Claude Code CLI | `~/.claude.json` or `.mcp.json` (project) | `mcpServers` | `claude mcp add kuzo -- npx kuzo-mcp serve` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers` | Manual / `kuzo setup` |
| VS Code / Copilot | `.vscode/mcp.json` | `servers` | Manual / `kuzo setup` |
| Cursor | `.cursor/mcp.json` | `mcpServers` | Manual / `kuzo setup` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | Manual / `kuzo setup` |

Note: Claude/Cursor use `mcpServers` root key; VS Code uses `servers`. No unified standard yet.

#### `kuzo setup` Command

Interactive wizard that handles everything from zero to working.

```
kuzo setup [--yes] [--plugins github,jira] [--skip-client-detection]
```

**Flow:**
1. **Detect MCP clients** — scan for Claude Code, Desktop, VS Code, Cursor, Windsurf by checking known config directories
2. **Plugin selection** — checkbox prompt: which integrations to enable
3. **Credentials** — per-plugin prompts with inline help links, live API verification
4. **Client registration** — write correct config format to each detected client (merge into existing, never clobber)

Credentials stored at `~/.kuzo/.env` (user-level, not project-level — never accidentally committed). Future: `@napi-rs/keyring` for OS keychain.

**Vibe coder path:** `npx kuzo-mcp setup` — zero-install wizard, same flow, no global install required.

**Team onboarding:** Repo ships `kuzo.config.ts` declaring required plugins. New dev runs `kuzo setup`, auto-prompted for missing plugins + credentials.

#### `kuzo doctor` Command

Diagnostic command that verifies everything is working.

```
kuzo doctor [--fix] [--json]
```

**Checks:** Core version, Node.js compatibility, plugin load status, credential API verification (GitHub `GET /user`, Jira `GET /myself`), MCP client config validity.

`--fix` auto-repairs what it can (re-register clients, reinstall declared plugins). `--json` for CI/scripts.

#### `kuzo plugins` Commands

```bash
kuzo plugins add github jira          # shorthand for kuzo-mcp-plugin-{name}
kuzo plugins remove jira
kuzo plugins list                     # installed + available
kuzo plugins update [--check]         # show/apply updates with changelog
kuzo plugins rollback github          # instant revert to previous version
```

#### Package.json Setup

```json
{
  "name": "kuzo-mcp",
  "bin": {
    "kuzo-mcp": "./dist/core/server.js",
    "kuzo": "./dist/cli/index.js"
  }
}
```

Two binaries: `kuzo-mcp` for the MCP server (what clients invoke), `kuzo` for the CLI (setup, doctor, plugins, consent).

#### `.mcp.json` Template

Shipped in the repo for team auto-discovery:

```json
{
  "mcpServers": {
    "kuzo-mcp": {
      "command": "npx",
      "args": ["-y", "kuzo-mcp", "serve"]
    }
  }
}
```

#### Acceptance Criteria

- [ ] `npm install -g kuzo-mcp` installs both `kuzo` and `kuzo-mcp` binaries
- [ ] `kuzo setup` detects and configures at least Claude Code + VS Code
- [ ] `kuzo doctor` verifies plugins, credentials, and client configs
- [ ] `npx kuzo-mcp serve` works as MCP server entry point
- [ ] `.mcp.json` template auto-discovered by Claude Code
- [ ] `kuzo plugins add/remove/list/update/rollback` manage standalone plugins
- [ ] First-time setup from zero to working MCP server in under 3 minutes

---

### Phase 3: Expand GitHub Plugin

**Goal:** Close the gap with the official GitHub MCP server and go beyond it.

The official `modelcontextprotocol/servers` GitHub MCP has ~26 tools. Our current GitHub coverage is 6 PR tools. Phase 3 fills the gaps and adds tools the official server doesn't have.

See [GitHub Plugin Gap Analysis](#github-plugin-gap-analysis) below for the full breakdown.

**New tool files:**

| File | Tools Added |
|------|-------------|
| `tools/releases.ts` | `create_release`, `list_releases`, `get_release`, `update_release`, `delete_release`, `upload_release_asset` |
| `tools/actions.ts` | `list_workflow_runs`, `get_workflow_run`, `trigger_workflow`, `cancel_workflow_run`, `list_artifacts`, `download_artifact`, `list_workflow_run_jobs` |
| `tools/labels.ts` | `create_label`, `list_labels`, `add_labels_to_issue`, `remove_label_from_issue` |
| `tools/issues.ts` | `create_issue`, `update_issue`, `list_issues`, `get_issue`, `search_issues`, `add_issue_comment` |
| `tools/branches.ts` | `list_branches`, `create_branch`, `get_branch_protection`, `update_branch_protection`, `delete_branch` |
| `tools/pulls.ts` (additions) | `merge_pull_request` (squash/rebase/merge), `convert_draft_to_ready`, `request_reviewers`, `update_pr_branch` |
| `tools/repos.ts` (additions) | `list_topics`, `add_topics`, `list_collaborators`, `add_collaborator`, `remove_collaborator`, `fork_repository` |

**Acceptance criteria:**
- [ ] All high-priority gaps closed (see gap analysis)
- [ ] Each tool has Zod input validation
- [ ] Each tool has clear LLM-facing descriptions with usage tips
- [ ] Medium-priority gaps have tracking issues

---

### Phase 4: New Integrations

**Goal:** Add new plugin integrations beyond GitHub and Jira.

| Plugin | API/Protocol | Key Tools | Config Required |
|--------|-------------|-----------|-----------------|
| **confluence** | Atlassian REST v2 | `get_page`, `create_page`, `update_page`, `search_pages`, `get_space` | `CONFLUENCE_HOST`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN` |
| **discord** | Discord REST API | `send_message`, `list_channels`, `get_messages`, `create_thread`, `add_reaction` | `DISCORD_BOT_TOKEN` |
| **calendar** | Google Calendar API | `list_events`, `create_event`, `update_event`, `find_free_time`, `delete_event` | `GOOGLE_CALENDAR_CREDENTIALS` |
| **sms** | Twilio REST API | `send_sms`, `list_messages`, `get_message` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` |
| **browser** | Chrome DevTools Protocol | `screenshot`, `navigate`, `get_page_content`, `click_element`, `record_video` | `CHROME_DEBUGGER_URL` (optional) |
| **notion** | Notion API v1 | `get_page`, `create_page`, `update_page`, `search`, `query_database` | `NOTION_API_KEY` |
| **slack** | Slack Web API | `send_message`, `list_channels`, `get_messages`, `add_reaction`, `upload_file` | `SLACK_BOT_TOKEN` |

**Priority order:** Confluence (shares Jira auth pattern) > Slack > Discord > Notion > Calendar > SMS > Browser

**Acceptance criteria:**
- [ ] Each plugin implements `KuzoPluginV2` with full capability declarations
- [ ] Each plugin published as standalone npm package (`kuzo-mcp-plugin-*`)
- [ ] Each plugin has its own types, client, and tool files
- [ ] Plugins with missing config are gracefully skipped
- [ ] Each plugin has a README in its directory with setup instructions

---

### Phase 5: Cross-Plugin Workflows

**Goal:** Composite tools that span multiple plugins.

**Examples:**

| Workflow | Plugins Used | Description |
|----------|-------------|-------------|
| `create_pr_and_link_jira` | github + jira | Create PR, extract Jira key from branch name, add PR link as Jira comment, transition ticket to "In Review" |
| `release_and_notify` | github + slack/discord | Create GitHub release, post announcement to Slack/Discord channel |
| `standup_summary` | jira + github | Gather yesterday's Jira transitions + merged PRs, format as standup update |
| `ticket_to_pr` | jira + github + git-context | Read Jira ticket, create branch from ticket key, create draft PR with ticket summary as description |
| `review_complete` | github + jira | Approve PR, merge, transition Jira ticket to "Done", post to Slack |

**Implementation approach:**

- Workflows are plugins themselves — they depend on other plugins via `callTool()`
- A `workflows/` directory under `plugins/` contains composite plugins
- Each workflow plugin declares its dependencies: `requires: ["github", "jira"]`
- Loader validates dependencies before loading workflow plugins
- Optional: event bus for plugin-to-plugin pub/sub (e.g., "PR merged" triggers Jira transition)

**Event Bus (future consideration):**

```typescript
interface PluginEvent {
  source: string;        // Plugin name that emitted
  type: string;          // Event type (e.g., "pr:merged")
  data: unknown;         // Event payload
}

// Added to PluginContext in Phase 5
interface PluginContext {
  // ... existing fields
  emit: (type: string, data: unknown) => void;
  on: (type: string, handler: (event: PluginEvent) => Promise<void>) => void;
}
```

**Acceptance criteria:**
- [ ] At least 2 cross-plugin workflows implemented
- [ ] Workflow plugins can declare and validate dependencies
- [ ] `callTool()` works reliably for cross-plugin communication
- [ ] Event bus implemented if pub/sub pattern proves necessary

---

## GitHub Plugin Gap Analysis

Comparison against the official GitHub MCP server (`modelcontextprotocol/servers`) and additional Octokit capabilities.

### Currently Implemented

| Tool | Status |
|------|--------|
| `create_pull_request` | Done |
| `update_pull_request` | Done |
| `get_pull_request` | Done |
| `list_pull_requests` | Done |
| `find_pr_for_branch` | Done |
| `get_pr_files` | Done (service method, not MCP tool yet) |
| `get_pr_reviews` | Done (service method, not MCP tool yet) |
| `submit_review` | Done (service method, not MCP tool yet) |
| `create_repository` | Done (service method, not MCP tool yet) |
| `get_repo_info` | Done (service method, not MCP tool yet) |
| `list_my_repos` | Done (service method, not MCP tool yet) |
| `update_repository` | Done (service method, not MCP tool yet) |

### High Priority Gaps

| Category | Tools | Effort |
|----------|-------|--------|
| **Releases** | `create_release`, `list_releases`, `get_release`, `update_release`, `delete_release`, `upload_release_asset` | Medium |
| **GitHub Actions** | `list_workflow_runs`, `get_workflow_run`, `trigger_workflow`, `cancel_workflow_run`, `list_artifacts`, `download_artifact`, `list_workflow_run_jobs` | Medium |
| **Labels** | `create_label`, `list_labels`, `add_labels_to_issue`, `remove_label_from_issue` | Small |
| **Milestones** | `create_milestone`, `list_milestones`, `update_milestone` | Small |
| **Notifications** | `list_notifications`, `mark_notification_read`, `mark_all_read` | Small |
| **Repo Settings** | `update_repository` (extended), `list_topics`, `add_topics`, `get_repository_details` | Small |
| **Branch Protection** | `get_branch_protection`, `update_branch_protection` | Small |
| **Collaborators** | `list_collaborators`, `add_collaborator`, `remove_collaborator` | Small |
| **PR Operations** | `merge_pull_request` (squash/rebase/merge strategies), `convert_draft_to_ready`, `request_reviewers` | Small |

### Medium Priority Gaps

| Category | Tools | Effort |
|----------|-------|--------|
| **Gists** | `create_gist`, `list_gists`, `update_gist`, `delete_gist` | Small |
| **Discussions** | `list_discussions`, `create_discussion`, `get_discussion` | Medium (GraphQL) |
| **Tags** | `create_tag`, `list_tags`, `delete_tag` | Small |
| **Deployments** | `list_deployments`, `create_deployment`, `get_deployment_status` | Small |
| **Check Runs** | `list_check_runs`, `get_check_run`, `create_check_run` | Small |
| **Repo Stats** | `get_contributors`, `get_commit_activity`, `get_code_frequency` | Small |
| **Rate Limit** | `get_rate_limit` | Trivial |

### Lower Priority Gaps

| Category | Tools | Notes |
|----------|-------|-------|
| **Code Scanning** | `list_code_scanning_alerts`, `get_alert` | Requires GitHub Advanced Security |
| **Dependabot** | `list_dependabot_alerts`, `update_alert` | Useful but niche |
| **GitHub Packages** | `list_packages`, `get_package_version` | Rarely needed via MCP |
| **Codespaces** | `create_codespace`, `list_codespaces` | Very niche |
| **Git Data API** | `create_blob`, `create_tree`, `create_ref`, `get_ref` | Low-level, rarely needed directly |

---

## Tech Stack

| Category | Choice | Notes |
|----------|--------|-------|
| **Language** | TypeScript 5.5+ | Strict mode, all compiler checks enabled |
| **Runtime** | Node.js 20+ | LTS, required for native fetch |
| **Module System** | ESM | `"type": "module"` in package.json |
| **MCP SDK** | `@modelcontextprotocol/sdk` | Official MCP SDK |
| **Validation** | Zod | Tool input schemas, config validation |
| **GitHub API** | `@octokit/rest` | Full GitHub REST API coverage |
| **Jira API** | Native fetch | Atlassian Cloud REST v3, no SDK needed |
| **CLI** | Commander + Inquirer | Interactive prompts, subcommands |
| **Logging** | Custom (chalk-based) | Refactored to support plugin-scoped prefixes |
| **Config** | dotenv + `kuzo.config.ts` | Env vars for secrets, config file for plugin enable/disable |
| **DI/IoC** | None | Factory functions + `PluginContext` — no framework needed |
| **Testing** | Vitest (planned) | Not yet set up, should be added in Phase 1 |
| **Build** | tsc | Direct TypeScript compilation to `dist/` |

---

## Design Principles

### 1. Plugins Own Their Domain

Each plugin manages its own:
- API client initialization and lifecycle
- Types and interfaces
- Tool definitions and handlers
- Input validation (Zod schemas)
- Error handling and error messages

The core never reaches into plugin internals. Plugins never reach into other plugins' internals.

### 2. PluginContext Is the Only Bridge

Plugins interact with the system exclusively through `PluginContext`:
- `config` for their env vars
- `logger` for structured logging
- `callTool()` for cross-plugin communication

No global singletons. No direct imports between plugins. No shared mutable state.

### 3. Graceful Degradation

If a plugin's required config is missing, it is **skipped, not crashed**. The server starts with whatever plugins are properly configured. The loader logs which plugins were skipped and why.

```
[INFO] Loaded plugins: git-context, github, jira
[WARN] Skipped plugins: confluence (missing CONFLUENCE_HOST), discord (disabled in config)
```

### 4. LLM-First Tool Design

Every tool description is written for the LLM, not the human developer:
- Clear description of what the tool does and when to use it
- Tips for common patterns (e.g., "call get_git_context first")
- Input schema with descriptions on every field
- Errors return helpful messages the LLM can act on

### 5. Start Simple, Abstract When Pain Appears

- No event bus until Phase 5 proves we need it
- No dependency injection framework — `PluginContext` is enough
- No plugin versioning/compatibility matrix until we have 10+ plugins
- No hot-reloading — restart the server when config changes

---

## Configuration

### Environment Variables (Secrets)

```bash
# GitHub (required for github plugin)
GITHUB_TOKEN=ghp_...
GITHUB_USERNAME=seantokuzo        # Optional: default owner for repo lookups
GITHUB_ORG=my-org                 # Optional: org context

# Jira (required for jira plugin)
JIRA_HOST=mycompany.atlassian.net
JIRA_EMAIL=sean@company.com
JIRA_API_TOKEN=ATATT3...

# Confluence (required for confluence plugin)
CONFLUENCE_HOST=mycompany.atlassian.net
CONFLUENCE_EMAIL=sean@company.com
CONFLUENCE_API_TOKEN=ATATT3...    # Can share with Jira if same Atlassian org

# Discord (required for discord plugin)
DISCORD_BOT_TOKEN=MTI...

# Twilio (required for sms plugin)
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...

# Google Calendar (required for calendar plugin)
GOOGLE_CALENDAR_CREDENTIALS=./credentials.json

# Notion (required for notion plugin)
NOTION_API_KEY=ntn_...

# Slack (required for slack plugin)
SLACK_BOT_TOKEN=xoxb-...

# General
DEBUG=true                        # Enable debug logging
CLI_PERSONALITY=chaotic           # CLI personality (professional/chaotic/zen)
DEFAULT_PR_BASE_BRANCH=main       # Default PR target branch
```

### Plugin Config (kuzo.config.ts)

Plugin enable/disable is defined as `DEFAULT_PLUGIN_CONFIG` in `src/core/config.ts`:

```typescript
const DEFAULT_PLUGIN_CONFIG: KuzoConfig = {
  plugins: {
    "git-context": { enabled: true },
    github: { enabled: true },
    jira: { enabled: true },
  },
};
```

Runtime config file loading (e.g., `kuzo.config.ts` at project root) will be added when there are more plugins to manage.

### Config Flow

```
1. Server starts
2. ConfigManager loads .env and reads DEFAULT_PLUGIN_CONFIG
3. Loader iterates enabled plugins from config
4. For each enabled plugin:
   a. Dynamic import from dist/plugins/{name}/index.js
   b. Check plugin.requiredConfig against process.env
   c. If missing vars -> skip plugin, log warning
   d. If all present -> build PluginContext with filtered config
   e. Call plugin.initialize(context)
   f. Register plugin's tools and resources in registry
5. Server is ready, only loaded plugins are active
```

---

## Anti-Patterns

Things we explicitly will NOT do:

| Anti-Pattern | Why It's Bad | What We Do Instead |
|-------------|-------------|-------------------|
| **God objects** | One class managing GitHub + Jira + git = unmaintainable | Each plugin manages its own state and client |
| **Circular dependencies between plugins** | Plugin A imports Plugin B imports Plugin A = deadlock | Use `callTool()` for all cross-plugin communication |
| **Global singletons** | `getGitHubService()` pattern makes testing impossible, hides dependencies | Everything flows through `PluginContext` |
| **Over-engineering** | DI containers, plugin versioning matrices, hot-reload before we need them | Start simple, add abstractions when pain appears |
| **Flat type files** | 420 lines of types for every domain in one file | Each plugin owns its types in `plugins/{name}/types.ts` |
| **Inline tool handlers** | All handler logic in `server.ts` = unreadable | Each tool group gets its own file in `plugins/{name}/tools/` |
| **Silent config failures** | Server starts but half the tools don't work because env vars are missing | Explicit load report: loaded, skipped (with reason), failed |
| **Direct plugin imports** | `import { GitHubService } from "../github/client"` inside the Jira plugin | Cross-plugin calls go through `callTool()` only |
| **Hardcoded tool names** | `case "create_pull_request":` in a switch statement | Registry-based dispatch: tools register themselves, server routes dynamically |

---

## Open Questions

1. **Tool name prefixing** — Should tools be prefixed with plugin name (`github_create_pr`) or kept flat (`create_pull_request`)? Prefixing avoids collisions but makes names longer. The official GitHub MCP uses flat names.

2. **CLI integration** — Should the CLI use the plugin registry to discover available commands, or should it directly import plugin modules? Registry approach is cleaner but adds complexity for the CLI use case.

3. **Testing strategy** — Vitest with mock PluginContext? Integration tests against real APIs with test tokens? Both? Need to decide before Phase 1 is "done."

4. **Plugin packaging** — Are plugins ever distributed separately (npm packages), or always in-repo? In-repo is simpler. Separate packages enable community plugins but add massive complexity.

5. **MCP SDK version** — Currently on `^1.0.0`. Need to verify latest version and whether newer versions have plugin-friendly patterns we should adopt.
