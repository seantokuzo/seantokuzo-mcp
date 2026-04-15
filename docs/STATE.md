# Session State

> Current state of the project. Updated each session.

**Last Updated:** 2026-04-15

---

## Current Phase

**Phase 0: Setup & Planning** (complete)

- Established plugin-based architecture direction
- Wrote full architecture spec (`docs/PLANNING.md`)
- Set up Claude tooling (hooks, rules, agents, skills, GitHub instructions)
- Customized CI workflow for Node.js/TypeScript

**Phase 1: Core Infrastructure** (complete — merged in PR #5)

- Plugin system types (`src/plugins/types.ts`)
- Structured logger with stderr output for MCP compatibility (`src/core/logger.ts`)
- Config manager with dotenv + per-plugin extraction (`src/core/config.ts`)
- Plugin registry with tool/resource indexing + cross-plugin callTool (`src/core/registry.ts`)
- Plugin loader with discovery, config validation, graceful skip (`src/core/loader.ts`)
- New MCP server delegating through registry (`src/core/server.ts`)
- Zod-to-JSON-Schema conversion for MCP tool listings
- Entry point: `npm run start:kuzo` / `node dist/core/server.js`

**Roadmap Update (2026-04-10):** Added Phase 2.5 — Plugin Security & Open-Source Readiness. The project now aspirationally aims to become an open-source centralized MCP platform (replacing the wasteful server-per-integration pattern). Full security model research/design/implementation will happen between Phase 2 and Phase 3, using Phase 2's 3 plugins as concrete design targets. See `docs/PLANNING.md` for the full spec.

**Phase 2 Sub-phase Split (2026-04-10):** Phase 2 is too large for a single PR. Split into 4 sub-phases, each its own branch + PR:
- **2.a** — git-context plugin (COMPLETE, merged PR #6)
- **2.b** — github plugin (COMPLETE, merged PR #7)
- **2.c** — jira plugin (COMPLETE, merged PR #8)
- **2.d** — cleanup + CLI migration (COMPLETE, merged PR #9)

Old code stays alive until 2.d so nothing breaks mid-flight. `src/core/server.ts` and `src/mcp/server.ts` coexist as separate entry points during the migration.

**Phase 2.a — git-context plugin** (complete — merged PR #6)
- `src/plugins/git-context/` with index, git detection, types, tool, and resource
- 1 tool (`get_git_context`) and 1 resource (`git://context`) exposed
- Cross-platform `findGitRoot` (Windows drive roots now terminate correctly)
- `_`-prefix convention respected by eslint (matches TS `noUnusedParameters`)

**Phase 2.b — github plugin** (complete — merged PR #7, 2026-04-11)
- `src/plugins/github/` — 23 MCP tools across 4 tool files (`pulls.ts`, `reviews.ts`, `repos.ts`, `branches.ts`)
- `GitHubClient` wraps Octokit with constructor-injected token and optional logger; no singleton, no global config
- `state.ts` holds module-local client reference, set in `initialize()` and accessed lazily by tool handlers via `getClient()` — avoids circular imports between `index.ts` and tool files
- `shared.ts` centralizes `parseRepoIdentifier` and `resolveRepository`; the latter is the first real use of cross-plugin `callTool("get_git_context", {})`. `GitContextResult` is defined locally and `as`-cast from the registry response (cross-plugin types stay loose until Phase 2.5)
- `create_pull_request` has a 3-tier target-branch cascade: explicit input → git-context `defaultBranch` → GitHub API `repo.default_branch` (handles `master` and custom defaults for repos with no local clone)
- `update_pull_request` body logic: append-mode treats null body as empty string; title-only updates leave body untouched so hand-written PR descriptions don't get wiped
- All list methods (`listBranches`, `listPullRequests`, `getPRCommits`, `getPRFiles`, `getPRFilesWithPatch`, `getPRReviews`, `getPRReviewComments`) use `octokit.paginate` — "all X" means all X
- Compare-based client methods (`getCommitsBetween`, `getDiffStats`, `getChangedFiles`) propagate Octokit errors instead of silently returning []/zeros; `create_pull_request` wraps them in its own try/catch so PR creation still degrades gracefully on transient compare failures
- `checkIssues` uses the Search API (`is:issue` qualifier) for accurate open/closed counts that exclude PRs, with a logged fallback to `repo.open_issues_count` if Search is rate-limited
- `getReadme`/`getFileContent` only swallow 404s; rethrow auth/rate-limit/5xx errors via a shared `getErrorStatus` helper
- Debug logs on mutating methods log metadata only (repo, head/base, title, pullNumber, `hasBody` flag) — never full config/body content
- `pull_number` and inline-comment `line` schemas use `.int().min(1)` so Zod rejects floats/NaN at validation time
- `parseRepoIdentifier` tolerates trailing slashes on GitHub URLs
- 4 rounds of Copilot review (29 comments total: 25 fixed, 4 deferred to Phase 2.5 — all 4 flagged redundant `Schema.parse()` in handlers, which needs a `ToolDefinition<TInput>` generic or `defineTool<S>` helper to fix properly and belongs with the broader type-contract work)
- Legacy `src/services/github.ts` and `src/mcp/server.ts` left intact — deleted in 2.d

**Phase 2.c — jira plugin** (complete — merged PR #8, 2026-04-11)
- `src/plugins/jira/` — 11 MCP tools across 4 tool files (`tickets.ts`, `transitions.ts`, `subtasks.ts`, `comments.ts`)
- `JiraClient` wraps native `fetch` with Basic auth (email:api_token → base64); constructor-injected host/email/token/logger, no singleton, no global config
- `state.ts` module-local client reference matches the github plugin pattern (`setClient`/`getClient`/`resetClient`)
- `adf.ts` houses `extractTextFromADF` (ported from legacy `JiraService`) and `textToADF` (inverse — wraps plain text in a single paragraph doc for writes); rich-text authoring is deferred, plain text is enough for 2.c
- Raw Jira API shapes stay as private interfaces inside `client.ts` (`JiraIssueRaw`, `JiraFieldsRaw`, `JiraTransitionRaw`, `JiraCommentRaw`); the plugin-owned types in `types.ts` are what tools actually consume
- `/search/jql` (POST) is the modern enhanced JQL endpoint — used for `searchTickets`, `getMyTickets`, and `getMyCodeReviews`
- `moveTicket` is the only high-level client helper: resolves a target transition by matching either the transition name OR the destination status name (case-insensitive), throws a descriptive error listing available transitions if nothing matches
- `createSubtask` does a follow-up `getTicket(newKey)` after `POST /issue` because the create response only returns `{id, key, self}` — status is workflow-dependent (not always "To Do") and assignee may be auto-populated by project defaults. One extra round-trip for authoritative data
- `JiraSubtask.assignee` is a nested `{accountId, displayName} | null` — caught drifting between displayName (getMyCodeReviews) and accountId (createSubtask) in review, forced every callsite to populate both
- Tool schemas use `.min(1)` on every non-empty string field (summary, description, comment, assignee_account_id, ticket_key, body). Empty strings fail validation up front instead of slipping past `.refine()` and getting silently dropped by the client. `labels: []` is the documented way to clear all labels
- Client methods use `!== undefined` consistently so debug logs and request bodies agree on what "provided" means
- `getTicket` does NOT `?expand=transitions` — `mapTicketResponse` never read that data and callers who need transitions hit `getTransitions()` directly
- Debug logs on mutating methods (updateTicket, transitionTicket, createSubtask, addComment, updateTicket) log metadata only (keys, field flags, lengths) — never full config/body content
- No cross-plugin concerns (cross-plugin Jira↔GitHub workflows are Phase 5). First plugin where `resolveRepository`-style cross-plugin callouts don't apply
- 2 rounds of Copilot review (8 comments total: all 8 fixed in-PR — empty-string consistency x4, ambiguous assignee type, hardcoded subtask status, wasted `?expand=transitions`, stale `update_ticket` doc string)
- Smoke test: `node dist/core/server.js` loaded `git-context` and `github`; `jira` was discovered + initialized but hit a 401 on `/myself` against a stale local API token — the legacy `JiraService.verifyConnection()` returned the identical 401, so code parity with the legacy service is the acceptance-criteria surrogate. User agreed to rotate the token out-of-band rather than block the PR
- Legacy `src/services/jira.ts` left intact — deleted in 2.d

**Phase 2.d — cleanup + CLI migration** (complete — merged PR #9, 2026-04-11)
- `src/cli/bootstrap.ts` — new side-effect `.env` loader, imported first in CLI entry so env vars are available during ESM dependency evaluation
- CLI commands (`pr.ts`, `repo.ts`, `review.ts`, `jira.ts`, `config.ts`) + `ui/display.ts` migrated from `getGitHubService`/`getJiraService`/`getConfig` singletons to direct `GitHubClient`/`JiraClient` instantiation + `process.env` reads
- Inlined helpers where plugin clients don't expose them: `parseRepoIdentifier` (repo.ts, later switched to shared import after Copilot review), `findPRByBranchInOrg` (review.ts), `appendToDescription` orchestration (jira.ts), `createGitHubClientFromEnv`/`createJiraClient` factories
- ~3566 LOC deleted: `src/services/{git,github,jira}.ts`, `src/mcp/server.ts`, `src/types/index.ts`, `src/server.ts` (orphaned Express webhook), `src/utils/{config,logger}.ts`, `src/index.ts` (barrel + banner)
- `package.json`: `start:kuzo` renamed to canonical `start:mcp`; `start`, `dev`, old `start:mcp`, `start:webhook` removed; `main` field removed; `express` + `@types/express` dropped (11 transitive packages pruned)
- `eslint.config.js`: stale ignore entries removed; `src/cli/` brought into the linted tree (6 pre-existing errors fixed)
- 1 round of Copilot review (3 comments: buggy regex in inlined `parseRepoIdentifier` → switched to shared import; error-swallowing try/catch in `findPRByBranchInOrg` → removed; generic `createJiraClient` error → explicit env var validation)

**Phase 2.5 warmup — `defineTool<S>` generic** (complete — merged PR #10, 2026-04-12)
- Added `defineTool<S>()` helper to `src/plugins/types.ts` — infers Zod schema type and gives handlers typed args (`z.infer<S>`) at definition time
- `ToolDefinition` interface stays non-generic (runtime/storage type); the generic lives only inside `defineTool()` to avoid `strictFunctionTypes` variance issues
- Migrated all 35 tools across 9 files (3 plugins) to use `defineTool()`
- Removed 34 redundant `Schema.parse(args)` calls — both `server.ts` and `registry.ts` already validate before calling handlers
- 0 Copilot review comments — clean merge
- Addresses 4 deferred comments from PR #7 (Phase 2.b)

**Phase 2.5 — Plugin Security & Open-Source Readiness** (research + design: COMPLETE, 2026-04-12)
- Full security design spec written: `docs/SECURITY.md`
- Research covered: sandboxing mechanisms (6 approaches evaluated), capability-based security (Deno, Chrome MV3, iOS/Android, object-capability model, Windows 11 MCP), credential management (5 storage backends, 4 broker patterns), supply chain (npm provenance, Sigstore, lockfile strategies), cross-plugin isolation (callTool scoping, intrinsic freezing, lifecycle isolation)
- **Architecture decisions made:**
  - **Sandboxing:** Child process per plugin (phased — in-process hardening first, process isolation when third-party plugins ship)
  - **Permissions:** Capability-based model with 5 categories (credentials, network, filesystem, cross-plugin, system). Declarative manifest v2 with typed `Capability` objects and `reason` fields.
  - **Credentials:** Hybrid broker — pre-auth clients for known services (GitHub, Jira) + scoped authenticated fetch + raw escape hatch with audit logging. `@napi-rs/keyring` replaces archived `keytar` for future OS keychain storage.
  - **Supply chain:** npm as plugin registry (`kuzo-mcp-plugin-*` convention), provenance via Sigstore required, manual update with rollback (never auto-update).
  - **Cross-plugin:** Scoped `callTool` via manifest dependencies, intrinsic freezing (`Object.freeze` on prototypes), `process.exit` guard, shutdown timeouts.
  - **Consent:** Dedicated `kuzo consent` CLI command (not runtime prompts — stdout is MCP transport). Trust overrides via `KUZO_TRUST_PLUGINS` env var. Consent stored in `~/.kuzo/consent.json`.
- 11 open questions documented for resolution during implementation (tool name prefixing, credential storage backend, SES evaluation, audit log destination, deprecation timeline, permission escalation policy)
- Implementation split into 5 sub-phases: 2.5a (manifest + hardening), 2.5b (credential broker), 2.5c (consent + audit), 2.5d (process isolation), 2.5e (supply chain)

**Phase 2.5a — Manifest + Hardening** (complete — PR #11, 2026-04-12)
- Discriminated union: `KuzoPluginBase` + `KuzoPluginV1` (legacy) + `KuzoPluginV2` (capabilities) with `permissionModel` discriminant and `isV2Plugin()` type guard. Decision: separate versioned interfaces > optional field accumulation (Chrome MV2→V3, Terraform protocol v5→v6 prior art)
- 5 capability types: `CredentialCapability`, `NetworkCapability`, `FilesystemCapability`, `CrossPluginCapability`, `SystemCapability` — discriminated union on `kind`
- V2 scoped `callTool`: loader extracts cross-plugin deps from capabilities, builds per-plugin scoped `callTool` that returns "not found" for undeclared targets (no info leak). V1 plugins keep unrestricted access.
- Intrinsic hardening: `Object.freeze()` on 7 key prototypes before plugin load. `process.exit` guarded with stashed `realExit` for core paths. Force-exit 10s timeout on SIGINT/SIGTERM. Idempotent shutdown (double-signal safe).
- Per-plugin 5s shutdown timeout via `Promise.race` in `registry.shutdownAll()`
- Collision error messages sanitized: stop naming existing plugin in tool/resource collisions
- All 3 plugins migrated to `KuzoPluginV2` with full capability declarations (git-context: filesystem+exec:git, github: credentials+network+cross-plugin, jira: credentials+network)
- V2 config extraction derives env vars from `CredentialCapability.env` instead of flat `requiredConfig`

**Phase 2.5b — Credential Broker** (complete — PR #12, 2026-04-12)
- `CredentialBroker` interface + `DefaultCredentialBroker` in `src/core/credentials.ts` — three access modes: `getClient<T>()` (pre-auth clients), `createAuthenticatedFetch()` (URL-scoped fetch), `getRawCredential()` (audit-logged escape hatch)
- Hardcoded client factories for first-party services: `"github"` → `GitHubClient`, `"jira"` → `JiraClient`. Core imports plugin clients directly (Option A — accepted coupling for first-party)
- Broker injected into `PluginContext` by loader alongside deprecated `config: Map`. V1 plugins receive `DefaultCredentialBroker` with empty capabilities (deny-by-default; `createAuthenticatedFetch()` throws). V2 plugins get fully scoped broker
- `context.config` wrapped in Proxy for V2 plugins — logs a one-time deprecation warning on any string property access
- GitHub plugin: `GITHUB_TOKEN` capability `access: "raw"` → `access: "client"`. `initialize()` calls `context.credentials.getClient<GitHubClient>("github")`. `GITHUB_USERNAME` stays `access: "raw"` (flows through factory automatically)
- Jira plugin: all 3 credential capabilities switched to `access: "client"`. `initialize()` calls `context.credentials.getClient<JiraClient>("jira")`
- git-context plugin unchanged — no credential capabilities, receives `DefaultCredentialBroker` with empty capabilities
- Capability enforcement: `getClient()` requires `access: "client"`, `getRawCredential()` requires `access: "raw"`, mismatches return `undefined` with warning log

**Phase 2.5c — Consent Flow + Audit** (complete — PR #13, 2026-04-12)
- `ConsentStore` in `src/core/consent.ts` — read/write `~/.kuzo/consent.json`, grant/revoke per-plugin, stale detection (version or capability changes trigger re-consent per open question #6)
- `AuditLogger` in `src/core/audit.ts` — dual-destination: JSON lines to `~/.kuzo/audit.log` + stderr via `KuzoLogger`. Events: `credential.client_created`, `credential.raw_access`, `credential.raw_denied`, `credential.fetch_created`, `plugin.loaded`, `plugin.skipped`, `plugin.failed`, `consent.granted`, `consent.revoked`, `consent.checked`. Query method with since/plugin/action filters
- Loader consent check: plugins require stored consent OR trust override before loading. Flow: V1 legacy gate → consent check → config validation → initialize
- Trust overrides: `KUZO_TRUST_PLUGINS=name1,name2` (selective), `KUZO_TRUST_ALL=true` (dev mode, logged warning), `KUZO_STRICT=true` (stored consent only, no overrides)
- V1 legacy gate: `KUZO_TRUST_LEGACY=true` required to load V1 plugins. Without it, V1 plugins are hard-blocked with clear upgrade message
- `context.config` removed from `PluginContext` — all V2 plugins use credential broker exclusively. Deprecation proxy deleted
- `requiredConfig`/`optionalConfig` removed from `KuzoPluginV1` interface — V1 plugins behind legacy gate get empty config
- Audit wired into `DefaultCredentialBroker`: `getClient()`, `createAuthenticatedFetch()`, `getRawCredential()` all emit structured audit events. Replaces inline `logger.info` audit lines
- 4 new CLI commands: `kuzo consent` (interactive review), `kuzo permissions` (list grants), `kuzo revoke [plugin]` (revoke consent), `kuzo audit [--since 7d]` (query audit log)
- CLI interactive menu updated with Security section (consent, permissions, revoke, audit)
- Consent/security commands bypass the GitHub config check (work without GITHUB_TOKEN)

**Phase 2.5d — Process Isolation** (complete — 2026-04-13)
- `src/core/ipc.ts` — JSON-RPC 2.0 protocol over Node IPC. `IpcChannel` class with request/response correlation via UUID, configurable timeouts, fire-and-forget notifications. Type guards for request/response/notification discrimination. Standard error codes (timeout, tool error, degraded).
- `src/core/plugin-host.ts` — Child process entry point (executed via `fork()`). Loads exactly one plugin, reconstructs `DefaultCredentialBroker` with scoped env vars + capabilities, builds IPC-backed `PluginContext` (logger relays to parent, `callTool` routes through parent registry). Handles `initialize`, `callTool`, `readResource`, `shutdown`, `ping`.
- `src/core/plugin-process.ts` — Parent-side `PluginProcess` manager per plugin. Lazy spawn on first tool call (zero startup cost). Crash recovery: exponential backoff (0/500ms/2s/8s/30s cap), reset after 60s stable, max 5 restarts in 5 min → `degraded` state. 30s heartbeat ping/pong with 5s timeout → kill + restart on no response. Graceful shutdown: IPC request → 5s timeout → SIGTERM → 3s → SIGKILL. Cross-plugin scope enforcement: child can only call tools in declared dependencies (checked in parent). `--max-old-space-size=256` per child. Optional Node Permission Model flags (`KUZO_NODE_PERMISSIONS=true`).
- `src/core/loader.ts` — No longer calls `plugin.initialize()` in parent. Imports plugin module read-only for manifest (tool schemas, capabilities), creates `PluginProcess` with scoped env vars, registers proxy `ToolDefinition`s (real Zod schemas, handlers proxy to child via IPC). New `shutdownAll()` method for child process lifecycle. Removed `buildScopedCallTool()` and `buildCredentialBroker()` (child builds its own).
- `src/core/server.ts` — Calls `loader.shutdownAll()` before `registry.shutdownAll()` on SIGINT/SIGTERM.
- Env var scoping: each child receives ONLY its declared credential env vars + system essentials (PATH, LANG, TERM, NODE_ENV, HOME, DEBUG). Jira child cannot read `GITHUB_TOKEN`.
- Smoke tested: 3 plugins register at startup with zero child processes, first `get_git_context` call spawns child (pid visible in logs), tool returns real data through full IPC round-trip, graceful shutdown terminates all children.

**Phase 2.5e — Supply Chain** (A.1–A.7 complete — PR #17 in review as `7eca0bc`, 2026-04-15; A.9–A.10 next session, then Parts B/C/D)

**A.1–A.3** (PR #15 merged as `9c15d7d`, 2026-04-14)

- **A.1 — pnpm prereqs** (`9b0b11c`): `packageManager: "pnpm@10.33.0"`, `.npmrc` with `strict-peer-dependencies=true`, `auto-install-peers=false`, `link-workspace-packages=deep`, `prefer-workspace-packages=true`; `pnpm import` → `pnpm-lock.yaml`.
- **A.2 — workspace shell** (`554c495`): `pnpm-workspace.yaml` (`packages/*`) + dormant `tsconfig.base.json` (composite, shared compiler opts).
- **A.3 — extract `@kuzo-mcp/types`** (`47c1aac`): `git mv src/plugins/types.ts → packages/types/src/index.ts`, scaffold workspace package with exports map, rewrite 25 importers from relative `../plugins/types.js` → `@kuzo-mcp/types`, switch root build/typecheck to `tsc -b` with reference to types, `.gitignore *.tsbuildinfo`.
- **CI fix** (`361c205`): workflow migrated npm → pnpm — `pnpm/action-setup@v4` before setup-node, `cache: pnpm`, `pnpm install --frozen-lockfile`, `pnpm run X`. Pulls in the CI piece of spec §A.1 Step 9 early.
- **Lint scope fix** (`dfb5d33`): `eslint src/` → `eslint .` per Copilot review. Flat config ignores (`dist/`, `node_modules/`) already exclude build output; packages/types/src now linted.

Two pnpm-config additions in root `package.json` beyond the literal spec, both forced by existing deps:
- `pnpm.peerDependencyRules.ignoreMissing: ["hono"]` — MCP SDK pulls `@hono/node-server` which peer-requires `hono@^4`; we only use stdio transport. Keeps `strict-peer-dependencies=true` honest for our own code.
- `pnpm.onlyBuiltDependencies: ["esbuild"]` — pnpm 10 blocks postinstall scripts by default; esbuild needs its postinstall to fetch its native binary for tsx.

**A.4–A.7** (PR #17 open as `7eca0bc`, 2026-04-15 — extract `@kuzo-mcp/{core,plugin-*,cli}` + loader rewrite + legacy `src/` cleanup, landed as one commit)

- **A.4 — extract `@kuzo-mcp/core`**: `git mv src/core/** → packages/core/src/**` (11 files). Scoped `@kuzo-mcp/core` package.json with subpath exports `.`, `./plugin-host`, `./loader`, `./consent`, `./audit`. Composite tsconfig with refs to `../types`, `../plugin-github`, `../plugin-jira` (for the credentials.ts client factory map + the plugin-resolver's dev-mode resolution scope).
- **A.5 — loader rewrite**: new `packages/core/src/plugin-resolver.ts` holds `BUILTIN_PLUGINS` map (`"github"` → `"@kuzo-mcp/plugin-github"` etc.) — hardcoded, NOT config-driven (security property per spec §A.5). `resolvePluginEntry(name, kuzoConfig)` tries installed-mode (`~/.kuzo/plugins/<name>/node_modules/<pkg>/`, overridable via `KUZO_PLUGINS_DIR` for the parity test) then falls back to dev-mode via `import.meta.resolve(pkg)`. Third-party plugins declare `packageName` in PluginConfig (new optional field on `@kuzo-mcp/types`). `loader.ts` calls `resolvePluginEntry()` + passes the URL through the IPC chain as `pluginEntryUrl` (not `pluginPath`). `plugin-process.ts` resolves the fork host via `fileURLToPath(import.meta.resolve("@kuzo-mcp/core/plugin-host"))`. `plugin-host.ts` takes the URL directly — dropped the `pathToFileURL()` wrapping because it's already a `file://`.
- **A.5 — extract 3 plugin packages**: `git mv src/plugins/<name>/** → packages/plugin-<name>/src/**` for all three. Each plugin declares `@kuzo-mcp/types` as BOTH `peerDependency` (publish-contract per §A.7 — avoids type-identity drift) AND `devDependency: workspace:*` (local dev — pnpm won't symlink peers with `strict-peer-deps=true` + `auto-install-peers=false`). `kuzoPlugin` metadata block on each (name, permissionModel, entry, minCoreVersion — inert until Part D).
- **A.6 — extract `@kuzo-mcp/cli`**: `git mv src/cli/** → packages/cli/src/**`. bundled into this commit (not a separate Step 6) because CLI files reached into plugin internals via `../../plugins/<name>/<file>.js` relative paths that would break in the interim between 5 and 6. New `packages/cli/package.json` owns the `kuzo` bin; subpath imports `@kuzo-mcp/plugin-github/{client,shared,types}`, `@kuzo-mcp/plugin-jira/{client,types}`, `@kuzo-mcp/core/{consent,audit}` across 7 files (pr.ts, repo.ts, review.ts, config.ts, consent.ts, jira.ts, ui/display.ts). `postbuild: chmod +x dist/index.js`.
- **A.7 — delete legacy `src/`**: gone after the moves. Root `tsconfig.json` flipped to solution-style (`{ files: [], references: [...] }` across all 6 packages). Root `package.json` stripped to dev-only deps + workspace scripts; dropped `bin`, dropped moved runtime deps (commander, inquirer, chalk, boxen, figlet, gradient-string, nanospinner, @octokit/rest, @modelcontextprotocol/sdk, zod-to-json-schema, dotenv, zod). `start:mcp` now `node packages/core/dist/server.js` (see tactical detail below).
- **ESLint ignore fix**: `dist/` → `**/dist/`, same for node_modules. Plain `dist/` only matched root in flat config.
- **Dotenv path depths** updated in `packages/core/src/config.ts` (repo root is 3 levels above `packages/core/dist/`) and `packages/cli/src/commands/config.ts` (4 levels above `packages/cli/{src,dist}/commands/`).

### ⏭️ Fresh-session handoff — when user says "next"

**Gate before starting:** check that PR #17 is merged to main. If still open and not merged, ask the user first — do NOT start Steps 9+10 off the unmerged branch because they need to land on top of the A.4–A.7 tree.

1. **Read `docs/2.5e-spec.md` §A.1 Steps 9 + 10** and **§A.8 (dev-to-install parity — non-negotiable gate)**. Skim §A.7 for the risks the parity test is meant to catch.
2. **Branch off fresh main** as `phase-2.5e/step-9-10-ci-parity` (or similar). `packages/{types,core,plugin-github,plugin-jira,plugin-git-context,cli}/` are all wired and green as of PR #17.
3. **Step 9 — CI + cross-plugin lint rule** (small — should be one commit):
   - Verify `.github/workflows/*.yml` still pass post-extraction. The CI fix in PR #15 migrated npm→pnpm — confirm it still walks all packages. May need `pnpm -r build` (it already does) plus maybe `pnpm -r test` once a test runner lands (deferred — no test runner yet).
   - Add an ESLint `no-restricted-imports` rule against cross-plugin imports between `packages/plugin-*`. Per spec §A.1 Step 9: "no cross-plugin imports between `packages/plugin-*`." The enforcement: any import path starting with `@kuzo-mcp/plugin-` from inside another `packages/plugin-*/` directory must error. Scope the rule via `files` globbed to `packages/plugin-*/src/**` so core/cli can still import plugin subpaths.
   - Verify the rule actually fires with a synthetic test import (add, run lint, see error, remove).
4. **Step 10 — dev-to-install parity test** (bigger — one commit, may get its own PR):
   - New file `scripts/test-install-parity.mjs` per spec §A.8. Steps: (a) `pnpm --filter @kuzo-mcp/plugin-<name> pack` per plugin → produces tarballs; (b) `mkdir -p $TMPDIR/kuzo-install-test/<name> && cd <name> && npm init -y && npm install <tarball>`; (c) `KUZO_PLUGINS_DIR=$TMPDIR/kuzo-install-test node packages/core/dist/server.js` + pipe a `tools/call` for a fast tool on that plugin via MCP JSON-RPC stdio; (d) assert `plugin.loaded` audit row + non-error response; (e) repeat for all three plugins. Clean up tmpdir on exit.
   - This is the contract test for §A.8 parity. **Non-negotiable per spec §A.9 "Do NOT skip".** It's the only thing that catches silent dual-mode resolution breakage — the dev branch works via pnpm symlinks, the installed branch exercises the tarball + `files` allowlist + `exports` subpaths + peerDep resolution + shebang bits.
   - Add a root script: `"test:parity": "node scripts/test-install-parity.mjs"`.
   - Wire into CI as a required gate when `packages/*/package.json` or `packages/core/src/{loader,plugin-resolver,plugin-process,plugin-host}.ts` change (per spec §A.8: "Run on every PR touching `packages/*/package.json` or the loader").
   - Note: running this test requires `pnpm pack` to actually include everything needed. If any plugin is missing a dep (e.g. `@kuzo-mcp/types` is peer-only + not hoisted in npm install — check behavior), this is where it surfaces.
5. **Verify green:** `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:parity`. Commit green.
6. **Commit message suggestion:** `feat(core): 2.5e A.9–10 — cross-plugin ESLint rule + dev-to-install parity test` (or split into two commits within one PR).
7. **Close Part A:** verify `docs/2.5e-spec.md` §E.1 acceptance criteria for Part A are satisfied. Also nudge the user about updating `docs/PLANNING.md` §2.5e (stale Turborepo/unscoped refs) and `docs/SECURITY.md` §5 per §E.1 — these land at phase close, not mid-Part.
8. **Then Parts B → C → D** per `docs/2.5e-spec.md` §0 Build Order. Each is its own PR.

### Source of truth

**`docs/2.5e-spec.md`** — 1405 lines, four-part spec:
- **Part A:** Monorepo restructure (10-step migration, pnpm workspaces, TS project references, loader rewrite)
- **Part B:** Release workflow + Trusted Publishing (copy-paste `release.yml`, Changesets config, npmjs.com setup, 12 gotchas)
- **Part C:** Pre-install provenance verification (sigstore@4 + pacote, trust policy, failure mode table, caching)
- **Part D:** Plugin install CLI (install/update/rollback commands, state files, locking, config mutation)
- **Part E:** Acceptance criteria + 10 open questions with recommended defaults

### Locked decisions (supersede older docs)

1. **pnpm workspaces only** — NOT Turborepo. Archetype: `modelcontextprotocol/typescript-sdk`. Turbo is a ~30 min add-later if CI pain emerges.
2. **Scoped `@kuzo-mcp/*` package names** — NOT unscoped `kuzo-mcp-plugin-*`. Enables friendly-name resolution (`install github` → `@kuzo-mcp/plugin-github`). Applied across all 6 packages as of PR #17.
3. **`tsc -b` is both build AND typecheck** — `tsc -b --noEmit` is not an option (TS6310: referenced composite projects may not disable emit). Accept the redundancy; tsbuildinfo makes subsequent runs near-free. Do not re-suggest this cleanup.
4. **Option A verification:** pre-install attestation fetch via npm registry API + `sigstore.verify()` (meta-package, NOT `@sigstore/verify` directly). There is no `npm install --require-provenance` flag in 2026 — we roll our own.
5. **Exact-name install for MVP.** No `kuzo plugins search` — deferred.
6. **Tokenless Trusted Publishing (OIDC) from day one** — no `NPM_TOKEN` secret. GA since July 2025.
7. **Retain last 3 versions per plugin** for rollback.
8. **Step 4+5+6+7 landed as one commit** (PR #17 / `7eca0bc`). Step 6 was bundled because CLI reached into plugin internals via relative paths; Step 7 is janitorial after 6.
9. **Subpath exports (not separate client packages)** — `@kuzo-mcp/plugin-github/client`, `@kuzo-mcp/core/consent` etc. Extracting clients into their own `@kuzo-mcp/clients-*` workspace packages ("Option C") was considered and deferred — proper decoupling but not 2.5e-blocking.
10. **Plugin packages declare `@kuzo-mcp/types` BOTH peer AND devDep workspace:\***. Peer is the publish-contract (§A.7 — avoids type-identity drift). DevDep is required for local dev because `strict-peer-deps=true` + `auto-install-peers=false` means pnpm won't symlink peer-only deps into the plugin's `node_modules`. Do not remove the devDep entry thinking it's redundant — it is not.
11. **`@kuzo-mcp/core` directly depends on all 3 plugin packages** — `plugin-github` + `plugin-jira` for the credentials.ts client factory map (Option A coupling, accepted in 2.5b); `plugin-git-context` purely so `import.meta.resolve("@kuzo-mcp/plugin-git-context")` can find it in core's resolution scope. Project refs in `packages/core/tsconfig.json` mirror this.
12. **`start:mcp` runs `node packages/core/dist/server.js` from repo root**, NOT `pnpm --filter @kuzo-mcp/core exec node dist/server.js` (spec §A.6 suggestion). pnpm --filter changes cwd to the package dir, which breaks the dotenv cwd fallback. Direct node invocation keeps cwd at repo root so `.env` is found.

### Branch state (post-A.7)

- **main** at `9c15d7d Phase 2.5e A.1–A.3: pnpm monorepo prereqs + @kuzo-mcp/types (#15)`
- **PR #17** open at `phase-2.5e/step-4-5-core-plugins` → `main` (commit `7eca0bc` — A.4–A.7). Fresh session must verify #17 is merged before branching for Steps 9+10.
- Fresh session should branch off whichever commit main points to after the #17 merge.

### Known tactical detail from A.4–A.7 session

- **`@kuzo-mcp/types` peer + devDep**: see locked decision #10. This is the #1 gotcha to re-derive if the plugin packages ever get a clean-slate rewrite.
- **Core's project refs**: `packages/core/tsconfig.json` has `references: [../types, ../plugin-github, ../plugin-jira]`. Without the plugin refs, `tsc -b` builds core before plugins, and the `@kuzo-mcp/plugin-github/client` subpath `.d.ts` files don't exist yet. If anyone adds a new plugin that core needs to factory-import, add the ref.
- **ESLint flat-config glob**: `ignores: ["dist/", ...]` does NOT match `packages/*/dist/` — needs `**/dist/`. Same lesson for any new nested output dir.
- **`git mv <dir> <target>/src/` nests by one level** (creates `<target>/src/<dir>/`). Flatten with `(cd <target>/src && for f in <dir>/*; do git mv "$f" .; done && rmdir <dir>)` per plugin. All 4 moves in this session needed the flatten step.
- **`git mv` + subsequent edits = RM entries** (staged rename, unstaged modify). `git add -u` after mv picks up the modification half. Without it, the first commit includes the rename but not the edits — tree doesn't build at that commit. Caught this in A.4–A.7 via `git reset --soft HEAD~1 && git add -u` and a re-commit.
- **Dotenv path depths**: `packages/core/dist/` is 3 levels below repo root; `packages/cli/{src,dist}/commands/` is 4 levels. If a new script in a different package needs `.env`, count the levels.
- **MCP end-to-end smoke**: `printf '{"jsonrpc":"2.0","id":1,"method":"initialize",...}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_git_context","arguments":{}}}\n' | KUZO_TRUST_ALL=true node packages/core/dist/server.js` boots + spawns a child + returns real tool data. Useful parity test seed.
- **pnpm dev:cli still requires a prior `pnpm build`** because `@kuzo-mcp/types` (and now core) resolve via `exports["."].import → ./dist/index.js`. Adding a `"development": "./src/index.ts"` exports condition is a post-2.5e cleanup.
- **Root `tsconfig.json` is now solution-style** (`{ files: [], references: [...] }` across all 6 packages). Adding a new package means: create package dir + scaffold, add to root tsconfig `references`, add to `pnpm-workspace.yaml` (already `packages/*` so automatic), add dep from whoever imports it, run `pnpm install`.

### Stale docs to expect (don't fix in isolation)

- **`docs/PLANNING.md` §2.5e (lines ~504-527):** still references Turborepo and unscoped `kuzo-mcp-plugin-*` names. Land at phase close per spec §E.1 — do not touch in a separate docs commit.
- **`docs/SECURITY.md` §5 (supply chain):** review + update at phase close per spec §E.1.

### PR strategy

- **PR #15 (merged)** — A.1–A.3: pnpm prereqs + `@kuzo-mcp/types`.
- **PR #17 (in review)** — A.4–A.7: extract `@kuzo-mcp/{core,plugin-*,cli}` + loader rewrite + legacy src/ cleanup.
- **Next PR** — A.9–A.10: CI no-cross-plugin ESLint rule + dev-to-install parity test. Could be one PR with two commits, or two small PRs — implementer's call but a single PR is fine.
- **Then Parts B → C → D** each their own PR per `docs/2.5e-spec.md` §0 Build Order.

### Do NOT

- Start with Part B, C, or D before Part A completes (Steps 9+10 still pending) — packages must exist AND the parity test must pass before publishing or installation logic can land.
- Rewrite `PLANNING.md` / `SECURITY.md` in isolation — those updates land at phase close (§E.1).
- Re-suggest `tsc -b --noEmit` for `typecheck` — blocked by TS6310 with composite projects; already evaluated in A.3.
- Open cross-session debate on spec §E.2 questions unless you actually hit them — use recommended defaults.
- Skip the parity test (§A.8) — it's the only gate that catches silent dual-mode resolution breakage. Non-negotiable per spec §A.9.
- Remove `@kuzo-mcp/types` from plugin `devDependencies` thinking the peer entry is enough — see locked decision #10. This will silently break local workspace builds.
- Change `start:mcp` back to `pnpm --filter @kuzo-mcp/core exec node dist/server.js` — see locked decision #12. Breaks dotenv cwd fallback.
- Extract plugin clients into `@kuzo-mcp/clients-*` packages ("Option C") as part of 2.5e. Intentionally deferred — it is proper decoupling but not phase-blocking. Subpath exports are the 2.5e-era answer.

### Phase 2.b Decomposition

**Goal:** Full GitHub integration as a plugin. All 27 methods on `GitHubService` either become MCP tools, become private client helpers, or get deleted. Plus: cross-plugin `callTool("get_git_context")` for auto-detect on PR operations — first real test of the Phase 1 cross-plugin API.

**Target tool count:** ~20 tools across 4-5 tool files.

**Internal Waves:**

| Wave | Scope | Files | Notes |
|------|-------|-------|-------|
| **1 — Foundation** | Types, Octokit client wrapper, plugin entry, shared helpers | `types.ts`, `client.ts`, `index.ts`, `shared.ts` | `client.ts` wraps Octokit, not a god object. `shared.ts` has `parseRepoIdentifier` and `resolveRepository` (the latter calls `context.callTool("get_git_context")` for auto-detect) |
| **2 — PR tools** | Biggest tool file — ports 5 existing tools + adds 5 new | `tools/pulls.ts` | Includes PR description generator (private helper, ported from `src/mcp/server.ts`) |
| **3 — Review tools** | PR reviews, review comments, submit review | `tools/reviews.ts` | 4 new tools, all previously service-only |
| **4 — Repo tools** | Create/get/update/list repos, README, issues check | `tools/repos.ts` | 6-7 new tools |
| **5 — Branch/File tools** | List branches, get file content, changed files | `tools/branches.ts` or merged into repos | 2-3 tools |
| **6 — Wire + smoke test** | Assemble plugin tools array, live-boot verify | `index.ts` | Both `git-context` and `github` plugins should load together |

**Tool inventory:**

PR tools (pulls.ts):
- `create_pull_request` (existing) — uses `callTool("get_git_context")` for auto-detect
- `update_pull_request` (existing) — auto-detect PR number via `find_pr_for_branch`
- `get_pull_request` (existing)
- `list_pull_requests` (existing)
- `find_pr_for_branch` (existing)
- `get_pr_files` (new)
- `get_pr_files_with_patch` (new)
- `get_pr_commits` (new)
- `get_changed_files` (new)
- `get_diff_stats` (new)

Review tools (reviews.ts):
- `get_pr_reviews`
- `get_pr_review_comments`
- `submit_review`
- `add_review_comment`

Repo tools (repos.ts):
- `create_repository`
- `get_repo_info`
- `update_repository`
- `list_my_repos`
- `get_readme`
- `update_readme`
- `check_issues`

Branch/File tools (branches.ts):
- `list_branches`
- `get_file_content`

**Plugin config:**
```typescript
requiredConfig: ["GITHUB_TOKEN"]
optionalConfig: ["GITHUB_USERNAME", "GITHUB_ORG"]
```

**Cross-plugin concerns:**
- `create_pull_request`, `update_pull_request`, `find_pr_for_branch` will call `context.callTool("get_git_context", {})` for auto-detect
- Return value shape is known (see `src/plugins/git-context/tools/context.ts`), github plugin will define a local `GitContextResult` interface and `as`-cast the result
- Cross-plugin type contracts are intentionally loose until Phase 2.5 formalizes them

**Acceptance:**
- All existing `GitHubService` API coverage exposed as MCP tools
- `create_pull_request` reaches feature parity (PR description generator works end-to-end)
- `src/services/github.ts` and legacy `src/mcp/server.ts` left intact — deletion in 2.d
- `node dist/core/server.js` boots with both `git-context` and `github` plugins loaded

---

### Phase 2.c Decomposition — jira plugin

**Goal:** Expose Jira service methods as MCP tools for the first time. Jira was previously CLI-only; this phase makes every Jira operation available to Claude via MCP.

**Target tool count:** 11 tools across 4 tool files.

**Internal Waves:**

| Wave | Scope | Files | Notes |
|------|-------|-------|-------|
| **1 — Foundation** | Types, HTTP client wrapper, plugin entry, ADF parser helper | `types.ts`, `client.ts`, `index.ts`, `adf.ts` | `client.ts` wraps `fetch` with Basic auth. `adf.ts` has `extractTextFromADF` ported from `JiraService` |
| **2 — Ticket tools** | Get/search/update tickets | `tools/tickets.ts` | 4 tools |
| **3 — Transition tools** | Get transitions, move by status name | `tools/transitions.ts` | 2 tools; `move_ticket` uses high-level name match |
| **4 — Subtask tools** | Create/list subtasks, code review subtasks | `tools/subtasks.ts` | 3 tools |
| **5 — Comment tools** | Add/list comments | `tools/comments.ts` | 2 tools |
| **6 — Wire + smoke test** | Assemble, live-boot verify | `index.ts` | All 3 plugins should load together |

**Tool inventory:**

Ticket tools (tickets.ts):
- `get_ticket` — fetch by key (e.g., "PROJ-123")
- `search_tickets` — JQL search with maxResults
- `get_my_tickets` — shorthand for assignee=currentUser, unresolved
- `update_ticket` — summary, description, labels, assignee

Transition tools (transitions.ts):
- `get_transitions` — list available transitions for a ticket
- `move_ticket` — high-level transition by status name (uses `get_transitions` internally)

Subtask tools (subtasks.ts):
- `create_subtask` — new subtask under a parent
- `get_subtasks` — list subtasks for a parent
- `get_my_code_reviews` — JQL shortcut for review subtasks assigned to me

Comment tools (comments.ts):
- `add_comment` — post ADF-formatted comment
- `get_comments` — list comments with ADF→text extraction

**Plugin config:**
```typescript
requiredConfig: ["JIRA_HOST", "JIRA_EMAIL", "JIRA_API_TOKEN"]
optionalConfig: []
```

**Cross-plugin concerns:** None in Phase 2.c. Cross-plugin Jira↔GitHub workflows (e.g., `create_pr_and_link_jira`, `ticket_to_pr`) are Phase 5.

**Acceptance:**
- All 11 Jira tools exposed via MCP
- `requiredConfig` validation gracefully skips the plugin if Jira env vars are missing
- `src/services/jira.ts` and `src/cli/commands/jira.ts` left intact — deletion in 2.d
- `node dist/core/server.js` boots with all 3 plugins (`git-context`, `github`, `jira`) loaded

---

### Phase 2.d Decomposition — cleanup + CLI migration

**Goal:** Delete the legacy monolithic code paths. Migrate the CLI to use the new plugin clients directly. Achieve feature parity with zero legacy code remaining.

**Scope:**
- **Delete:** `src/services/git.ts`, `src/services/github.ts`, `src/services/jira.ts`, `src/mcp/server.ts`, `src/types/index.ts`
- **Migrate:** 5 CLI command files (`pr.ts` 1358 LOC, `repo.ts` 877 LOC, `review.ts` 723 LOC, `jira.ts` 936 LOC, `config.ts` 289 LOC) — ~4200 LOC of import updates and service→client swaps
- **Update:** `src/index.ts` exports
- **Investigate:** `src/server.ts` (Express webhook, 275 LOC, marked "unused?" in STATE.md)
- **Decide:** fate of `src/utils/config.ts` (143 LOC) and `src/utils/logger.ts` (85 LOC)
- **Scope check:** every `import .* from .*types/index` and every `import .* from .*services/` must be rewritten or removed

### Decision Points (resolve BEFORE code execution)

These decisions affect scope significantly — the executing session should confirm with the user upfront instead of guessing:

1. **CLI migration strategy**
   - **(a) Direct client imports** *(recommended)* — CLI imports `GitHubClient` / `JiraClient` from plugin directories. Mechanical 1:1 replacement of `getGitHubService()` → `new GitHubClient(token)`. Preserves CLI ergonomics, ~1000 LOC of find/replace work. Doesn't violate the "plugins don't import plugins" rule since the CLI isn't a plugin.
   - **(b) Registry-based** — CLI instantiates `PluginRegistry` + `PluginLoader` and routes through `registry.callTool(...)`. Architecturally pure but heavyweight for a CLI. Each command would serialize args, go through Zod validation twice, deserialize the JSON result. Not worth it.
   - **(c) Delete the CLI entirely** — MCP is now the primary interface via Claude; CLI becomes dead weight. Only consider if the CLI isn't actively used.

2. **`src/utils/logger.ts` fate**
   - **(a) Keep** *(recommended)* — CLI needs a **stdout** logger for normal output; the new `src/core/logger.ts` writes exclusively to **stderr** (because stdout is the MCP transport). Keeping the old CLI logger is the simplest path.
   - **(b) Delete and extend core logger** — Add a `destination: "stdout" | "stderr"` option to `KuzoLogger`. More work, marginal benefit.

3. **`src/utils/config.ts` fate**
   - **(a) Delete** *(recommended)* — After CLI migration, the old flat `Config` interface has no consumers. `ConfigManager` in `src/core/config.ts` replaces it for plugin-aware code; CLI can read env vars directly.
   - **(b) Keep** — If `config.ts` CLI command logic depends on it heavily. Check `src/cli/commands/config.ts` before deciding.

4. **`src/server.ts` (Express webhook) fate**
   - **Action:** `git log` the file + `grep` for references. STATE.md marks it "unused?" — verify, then delete if no consumers. The webhook pattern is a dead end for a stdio-based MCP server anyway.

### Waves

| Wave | Scope | Dependencies |
|------|-------|--------------|
| **0 — Decision gate** | Confirm the 4 decision points above with user | — |
| **1 — Delete legacy services** | Remove `src/services/git.ts`, `github.ts`, `jira.ts` | Decision gate |
| **2 — CLI migration** | 5 command files, replace service calls with plugin client imports, replace type imports | Wave 1 (broken imports are the forcing function) |
| **3 — Delete legacy MCP server** | Remove `src/mcp/server.ts`, update `package.json` scripts (remove `start:mcp`, promote `start:kuzo` → `start:mcp`) | Wave 2 |
| **4 — Delete flat types file** | Remove `src/types/index.ts`, update `src/index.ts` exports | Waves 1-3 |
| **5 — Delete webhook server** | Remove `src/server.ts` if confirmed unused | — |
| **6 — Delete old config utility** | Remove `src/utils/config.ts` if decision (3a) was chosen | Wave 2 |
| **7 — Eslint cleanup** | Remove `src/services/`, `src/mcp/`, `src/server.ts` from `eslint.config.js` ignore list (files no longer exist) | Waves 1, 3, 5 |
| **8 — Full verify** | lint, typecheck, build, smoke test MCP server with all 3 plugins loaded, smoke test each CLI command | All waves |

### Acceptance

- [ ] Zero references to `src/services/*`, `src/mcp/server.ts`, `src/types/index.ts` in the codebase
- [ ] All 5 CLI commands work end-to-end (manual smoke test)
- [ ] `npm run start:kuzo` (or renamed `start:mcp`) loads git-context + github + jira plugins
- [ ] `npm run lint && npm run typecheck && npm run build` — all clean
- [ ] `eslint.config.js` no longer ignores pre-refactor paths (because they don't exist)
- [ ] No ruleset bypasses needed for merge — branch protection config resolved

---

### Execution Strategy for the Mega Pass

**Combined scope of 2.b + 2.c + 2.d:**
- ~2300 LOC of new plugin code (2.b + 2.c)
- ~5500 LOC of deletions (2.d)
- ~1000 LOC of CLI migration (2.d)
- ~20 files touched for plugins, ~10 files touched for deletions/migration
- 3 separate PRs (one per sub-phase)

**Recommended execution split** (within the mega pass):

1. **Session 1 — Phase 2.b (github plugin).** Full PR cycle: branch, build, PR, address review, merge. Natural stopping point at merge.

2. **Session 2 — Phase 2.c (jira plugin).** Similar pattern, same shape, different API. Natural stopping point at merge.

3. **Session 3 — Phase 2.d (cleanup).** Different kind of work — deletions + mechanical migration + decision gate. Best done with fresh context after 2.b and 2.c are battle-tested.

**Alternative:** If the executing session has fresh max-reasoning context and aggressive subagent delegation, 2.b + 2.c could fit in one session since they follow the same pattern. 2.d should still be its own session because of the decision gate and the qualitative difference in the work.

**Why not all three in one session:** Combined LOC activity is ~8000. CLAUDE.md's context management guide flags 15+ files per task as a "spawn subagent" signal — this mega pass hits that by the end of 2.b alone. Context rot will degrade quality on 2.d decisions unless the session delegates aggressively.

---

## What Exists Today

### Core (Phase 1 + 2.5a + 2.5b + 2.5c)
- Plugin system core (`src/core/` — server, registry, loader, config, logger, credentials, consent, audit)
- Plugin type definitions (`src/plugins/types.ts`) — `KuzoPluginV1`/`V2` discriminated union, 5 capability types, `CredentialBroker` interface, `defineTool<S>()` helper, `isV2Plugin()` type guard
- Runtime hardening: prototype freezing, `process.exit` guard, per-plugin shutdown timeouts, force-exit safety net
- V2 scoped `callTool`: plugins can only call declared cross-plugin dependencies
- Credential broker: `DefaultCredentialBroker` with `getClient<T>()`, `createAuthenticatedFetch()`, `getRawCredential()`. First-party factories for GitHub + Jira. All access audit-logged
- Consent flow: `ConsentStore` manages `~/.kuzo/consent.json`. Loader checks consent before plugin load. Trust overrides via env vars. V1 plugins gated behind `KUZO_TRUST_LEGACY`
- Audit log: `AuditLogger` writes JSON lines to `~/.kuzo/audit.log` + stderr. Covers credential access, plugin lifecycle, consent changes

### Plugins (Phase 2 + 2.5a–c)
- `src/plugins/git-context/` — 1 tool, 1 resource. V2 manifest: filesystem + system:exec:git. No credentials (empty-capabilities broker)
- `src/plugins/github/` — 23 tools across pulls/reviews/repos/branches. V2 manifest: credentials(client) + network + cross-plugin:git-context. Initialized via `credentials.getClient<GitHubClient>("github")`
- `src/plugins/jira/` — 11 tools across tickets/transitions/subtasks/comments. V2 manifest: credentials(client) + network. Initialized via `credentials.getClient<JiraClient>("jira")`

### CLI (Phase 2.d)
- Interactive CLI with PR, repo, review, jira, config commands (`src/cli/`)
- Uses plugin clients directly (`GitHubClient`, `JiraClient`) — no legacy service singletons
- `src/cli/bootstrap.ts` loads `.env` as ESM side-effect before any command module
- Bash CLI alternative still at `cli-bash/` (untouched)

### Legacy Code — Fully Deleted (Phase 2.d, PR #9)
All legacy code paths removed. No monolithic services, no flat type barrel, no webhook server, no legacy MCP entry. Directories `src/services/`, `src/mcp/`, `src/types/`, `src/utils/` no longer exist.

### Not Yet Built
- Supply chain security (Phase 2.5e — NEXT UP)
- Phase 3+ GitHub plugin expansion (releases, actions, labels, issues, etc.)
- New integrations (Phase 4: Confluence, Discord, SMS, Calendar, Notion, Slack)
- Cross-plugin workflows (Phase 5)
- Tests (vitest not yet configured)

---

## Decisions Made

| Decision | Date | Rationale |
|----------|------|-----------|
| Plugin-based architecture (Option B) | 2026-04-09 | Modular but unified, clean separation, can grow without rotting |
| No DI framework | 2026-04-09 | PluginContext + factory functions is enough for our scale |
| Keep CLI alongside MCP | 2026-04-09 | CLI uses plugin registry for tool discovery |
| Zod for all validation | 2026-04-09 | Already in use, works well with MCP SDK |
| ESM only | 2026-04-09 | Already configured, no reason to support CJS |
| Packaging: local node command (Option A) | 2026-04-10 | `node dist/mcp/server.js` registered in Claude settings. Claude auto-starts it. npm publish (Option B) is an eventual goal for sharing/multi-machine use |
| Discriminated union for plugin manifests | 2026-04-12 | `KuzoPluginV1 \| KuzoPluginV2` with `permissionModel` discriminant. Separate versioned interfaces > optional field accumulation. Prior art: Chrome MV2→V3, Terraform protocol v5→v6. Prevents junk drawer as security model evolves through V3+. |
| process.exit guard + stashed realExit | 2026-04-12 | Override `process.exit` to block plugin DoS, stash real exit for core paths. Becomes irrelevant after Phase 2.5d (process isolation). Option B (exitCode + drain) broken for stdio servers — transport keeps event loop alive. |

---

## Deferred Items

- Tool name prefixing strategy (prefix with plugin name or keep flat?)
- Testing strategy (vitest setup, mock vs real API)
- Plugin packaging (in-repo only for now, npm packages later if needed)
- Event bus for cross-plugin pub/sub (Phase 5)
