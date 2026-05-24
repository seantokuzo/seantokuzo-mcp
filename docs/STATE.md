# Session State

> Current state of the project. Updated each session.

**Last Updated:** 2026-05-24 (Phase 2.6 Theme 6 — broker write-side audit slots + shutdown hooks + retire `clientFactories` module-level singleton — merged via PR #53 on 2026-05-24 at `fd580de`. **4 rounds, impartial judge merge HIGH confidence at the hard cap.** Verdict trend: SHIP 0/2 → SHIP 0/5 → SHIP 0/1 → SHIP 0/2 — every round zero blocking, all 3 specialists shipped clean each round. Fix commits: `f6f7e5b` (R1 Sec A1 — construction-time `clientFactories` guard against first-party reservation set), `a1cd799` (R2 — sticky `hasEmittedClose` for idempotent `credential.store_locked` + try/finally around `plugin.shutdown()` so broker scrub runs on plugin shutdown rejection + dropped redundant `as AuditEvent` cast in test helper), `2185581` (R3 — clarified third-party factory manifest-contract delegation in JSDoc on `CredentialBroker.registerClientFactory` + inline comment in `getClient`), `dd63ad7` (R4 — dropped redundant `factory as ClientFactory` cast via return-type covariance + documented lock-once-per-instance lifecycle contract on `hasEmittedClose` JSDoc). **Verdict synthesizer crashed in R3 AND R4** (same 30-turn-cap gotcha class as Theme 4 R4 + Theme 5 R3 — recurring CI fragility on the synth job only); the 3 specialist JSON sentinels are the canonical signal across R3/R4 and the impartial judge was fed those plus the round-by-round fix log instead of a synthesized sticky. **Code surface:** `audit.ts` extended with 7 new write-side `AuditAction` variants (`credential.set` / `.deleted` / `.rotated` / `.migrated` / `.migration_partial` / `.wiped` / `.tested`); `audit-partition.ts` classifies all 7 as `parent-only` — the `Record<AuditAction, ...>` exhaustiveness check forces compile-time classification, and the IPC boundary in `plugin-process.handleAuditEvent` (via `CHILD_PERMITTED_AUDIT_ACTIONS`) rewrites any compromised-child emission attempt as `audit.forged_action`. Slot reservation only — Theme 7/8 wire the actual producers via the `kuzo credentials *` CLI surface. `credentials.ts` rewritten: `clientFactories` Map retired from module scope (round-4 advisory A1) and now lives as instance state pre-loaded from a module-level `FIRST_PARTY_FACTORIES` constant; `FIRST_PARTY_SERVICE_ENVS` likewise instance-adjacent. New `registerClientFactory<T>(service, factory)` method on `CredentialBroker` (`@kuzo-mcp/types`) — first-party names (`"github"` / `"jira"`) are write-locked via the immutable reservation key set at BOTH the runtime register path AND the construction-time `clientFactories` test-seam (R1 Sec A1); idempotent no-op on re-registration; third-party factories deliberately skip the first-party `access:"client"` manifest-contract check per spec §C.4 (loader scopes config by env-name not access mode — self-contained, no cross-trust escalation; consent UI is the user-facing line of defense, JSDoc spells this out explicitly). New `DefaultCredentialBroker.shutdown()` method drops config + clientFactories + clientCache Maps; wired into `plugin-host.handleShutdown` AFTER `plugin.shutdown()` and BEFORE `process.exit` inside a try/finally so the scrub fires even on plugin shutdown rejection (R2 Sec/Corr advisory). `EncryptedCredentialStore.close()` audit emit reshaped per spec §C.5: unconditional emit with `priorCount` + `backend` in details (never-unlocked close now emits priorCount=0 — forensic "stopped without ever unlocking" correlation); sticky `hasEmittedClose` flag gates repeated emit so signal-handler + idempotent teardown double-close stays silent (R2 Arch/Sec A1); `wipeKeyCache?.()` still runs on every close so malformed teardown can never leave the master key Buffer populated. New `packages/core/src/credentials.test.ts` (14 broker tests covering first-party override rejection at both gates, idempotent re-registration, third-party env-list skip, audit emit on first client creation, client cache hit, clientFactories override seam preserving reservation gate, shutdown clears all three Maps, idempotent shutdown, no shutdown audit from broker, construction-time guard against malicious first-party override); +2 store double-close tests in `store.test.ts` (triple-close emits once with priorCount=1; never-unlocked double-close emits once with priorCount=0). 113 credentials tests pass via `pnpm test:credentials` (97 prior + 14 broker + 2 close-idempotency). **Pushbacks documented:** R2 Architecture "static `forTesting()` factory" refactor → won't-fix: R1 construction-time guard already structurally enforces the reservation invariant on the constructor path; moving the seam behind a static method changes access surface without changing security posture and breaks the legitimate third-party `registerClientFactory` test pattern that needs an isolated factory map. R3 Security third-party access-mode skip → addressed-as-docs (not pushback): spec §C.4 mandates the delegation; JSDoc on `registerClientFactory` now spells out the manifest-contract responsibility explicitly (R4 Security explicitly endorsed: "well-documented in JSDoc. The 'self-contained, no cross-trust escalation' argument is sound"). Tier 3 deep-review auto-escalated on the R2 541-line threshold; same issue #48 bot-allowlist failure as every prior Theme PR. Standard CI all green at the head SHA before merge. **Next:** Theme 7 — B.1–B.3 + A.11 + A.12 — `kuzo credentials set/list/delete/rotate/status/test/wipe` CLI commands + file state machine + strict env-name reservation install-time validation; also picks up the Theme 4 round-4 deferred ESLint dynamic-import + plugin-name path-traversal advisories. **Original Theme 5 summary retained below for archaeology:** Phase 2.6 Theme 5 — audit IPC routing + rate-limit + log rotation — merged via PR #51 on 2026-05-23 at `026fcc0`. **4 rounds, impartial judge merge HIGH confidence at the hard cap.** Verdict trend: SHIP 0/5 → SHIP 0/7 (5 unique) → SHIP 0/6 → **fix-then-ship 1/5** across the 4 rounds — first 3 rounds shipped with zero blocking, round-4 raised one BLOCKING Security finding (child-supplied `timestamp` smuggling via spread order in `FileBackedAuditLogger.log`) that was fixed in `4c6caa4`. Fix commits: `d23d62d` (round-1 4 fixes + 1 defer), `f7702c6` (round-2 5 fixes), `f8a2014` (round-3 6 fixes), `4c6caa4` (round-4 1 BLOCKING + 3 advisories + 2 pushbacks). Round-3 verdict synthesizer crashed on its 30-turn cap (same gotcha as Theme 4's checkout-auth glitch but a different failure mode); all 3 specialists posted clean JSON sentinels and the round-3 fix was applied without a synthesized sticky. **New code surface:** `packages/core/src/audit.ts` split — `AuditLogger` is now an interface; new `FileBackedAuditLogger` concrete implements it; `audit.log` rotation (50 MiB threshold, 5 retained, atomic rename only, stat amortized every 100th write) and `query()` globbing across `audit.log` + `audit.log.{1..5}` added; `mkdirSync` mode `0o700`; `appendFileSync` mode `0o600`; `safeStringify` helper wraps both the file write and the stderr echo in a never-throw envelope; all imports use `node:fs` / `node:path` prefix. `packages/core/src/audit-partition.ts` (new) — `Record<AuditAction, "parent-only" | "child-permitted">` literal forces TS compile error if any future variant lacks classification; derived `CHILD_PERMITTED_AUDIT_ACTIONS` Set is the runtime allowlist. `packages/core/src/audit-ipc.ts` (new) — `TokenBucket` (wall-clock, 200 burst / 100 refill-per-sec, injectable `now` for tests); `decideAudit(event, declaredPluginName, childPid)` returns `{ kind: "forged_plugin" | "forged_action" | "allow" }` and constructs the stamped event from **explicit named fields** (no spread of untrusted wire — round-4 BLOCKING fix); `isAuditWireEvent` validates the 4 wire fields with closed-enum `outcome` + array `details` rejection; `withinAuditByteCap(event)` uses `Buffer.byteLength(json, "utf8")` against `AUDIT_WIRE_MAX_BYTES = 16 * 1024`. `packages/core/src/plugin-host.ts` rewritten — `IpcAuditLogger` proxy `implements AuditLogger`, forwards via `channel.notify("audit", { event })` with a `try/catch` around `notify` (round-2 fix, never-throw contract). `packages/core/src/plugin-process.ts` extended with audit notification handler that consumes from `auditBucket` BEFORE wire validation (round-3 Security advisory) so malformed / oversize / forged frames all count toward the rate limit; `handleAuditEvent` does PID + source stamp via `decideAudit`, then `forged_plugin_field` / `forged_action` / trusted-path emit; `reportRateLimitIfDue` + `flushRateLimitDrops` + `scheduleTrailingRateLimitFlush` ensure no trailing drop count is lost when a burst ends mid-window; `cleanup()` drains any pending drops before clearing `childPid`. `packages/core/src/server.ts` emits one-time `audit.partition_initialized` at boot. `eslint.config.js` adds a `plugin-host{*,/**/*}.ts`-scoped block banning `appendFile` / `appendFileSync` from `node:fs` + `fs/promises`, the `FileBackedAuditLogger` named import (relative + subpath), and a `no-restricted-syntax` selector for `*.appendFile*` member-calls (catches namespace-import bypass). 4 new `AuditAction` variants: `audit.forged_plugin_field`, `audit.forged_action`, `audit.rate_limited`, `audit.partition_initialized`. **Round-1 SEC catch:** wire validator was permissive on extra fields → led directly to round-4 Security BLOCKING + the explicit-field-construction fix in `decideAudit`. **Round-4 SEC BLOCKING (the headline):** `audit.ts` previously did `{ timestamp: new Date()..., ...event }` — child-supplied `timestamp` would override the parent's authoritative one. Fix layers two defenses: (1) `decideAudit` explicitly takes only the 4 wire fields + stamps source/pid, so smuggled timestamp/pid/source never reach the file writer via IPC; (2) `FileBackedAuditLogger.log` flipped the spread to `{ ...event, timestamp: new Date().toISOString() }` so the parent stamp wins regardless of caller. 3 new tests lock the invariants (timestamp-doesn't-leak, pid-doesn't-smuggle-when-childPid-undefined, exact-field-count). 47 total `node:test` cases now (`pnpm test:audit` — 31 audit-ipc + 16 misc; was 0 before this Theme). New `test:audit` script chained into root `pnpm test`. **Pushbacks documented:** changeset cadence (pre-1.0 batches at phase close, not per-Theme — same as Theme 4), forgery-flood retention erosion → issue #52 (spec divergence — aggregating diverges from §C.10 per-attempt emission), relative-import bypass via hypothetical `plugin-host/` subdir (forward-compat; `files:` glob already widened, switch `paths:` → `patterns:` only when the subdir actually exists). Tier 3 deep review didn't auto-escalate this round despite the >500-line threshold — synth's auto-escalation logic on round 4 with 0/0 final SHIP saw the post-fix state as ship-ready. Impartial judge sub-agent (fresh `general-purpose`, no review history) confirmed merge with HIGH confidence: "BLOCKING fix is structurally airtight: stamped event is built field-by-field from named wire fields … smuggling closed by construction, not by check-then-trust". Standard CI (Lint/Typecheck/Build/Install parity/Provenance smoke) all green. **Next:** Theme 6 — C.4–C.6 — Broker write-side audit events + shutdown hooks; retire module-level `clientFactories` singleton.)

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

**Phase 2.5e — Supply Chain** (Part A complete pending merge of A.9–A.10 PR; Parts B/C/D remain)

**A.1–A.3** (PR #15 merged as `9c15d7d`, 2026-04-14)

- **A.1 — pnpm prereqs** (`9b0b11c`): `packageManager: "pnpm@10.33.0"`, `.npmrc` with `strict-peer-dependencies=true`, `auto-install-peers=false`, `link-workspace-packages=deep`, `prefer-workspace-packages=true`; `pnpm import` → `pnpm-lock.yaml`.
- **A.2 — workspace shell** (`554c495`): `pnpm-workspace.yaml` (`packages/*`) + dormant `tsconfig.base.json` (composite, shared compiler opts).
- **A.3 — extract `@kuzo-mcp/types`** (`47c1aac`): `git mv src/plugins/types.ts → packages/types/src/index.ts`, scaffold workspace package with exports map, rewrite 25 importers from relative `../plugins/types.js` → `@kuzo-mcp/types`, switch root build/typecheck to `tsc -b` with reference to types, `.gitignore *.tsbuildinfo`.
- **CI fix** (`361c205`): workflow migrated npm → pnpm — `pnpm/action-setup@v4` before setup-node, `cache: pnpm`, `pnpm install --frozen-lockfile`, `pnpm run X`. Pulls in the CI piece of spec §A.1 Step 9 early.
- **Lint scope fix** (`dfb5d33`): `eslint src/` → `eslint .` per Copilot review. Flat config ignores (`dist/`, `node_modules/`) already exclude build output; packages/types/src now linted.

Two pnpm-config additions in root `package.json` beyond the literal spec, both forced by existing deps:
- `pnpm.peerDependencyRules.ignoreMissing: ["hono"]` — MCP SDK pulls `@hono/node-server` which peer-requires `hono@^4`; we only use stdio transport. Keeps `strict-peer-dependencies=true` honest for our own code.
- `pnpm.onlyBuiltDependencies: ["esbuild"]` — pnpm 10 blocks postinstall scripts by default; esbuild needs its postinstall to fetch its native binary for tsx.

**A.4–A.7** (PR #17 merged as `09011fe`, 2026-04-15 — extract `@kuzo-mcp/{core,plugin-*,cli}` + loader rewrite + legacy `src/` cleanup, landed as one squash-merged commit)

- **A.4 — extract `@kuzo-mcp/core`**: `git mv src/core/** → packages/core/src/**` (11 files). Scoped `@kuzo-mcp/core` package.json with subpath exports `.`, `./plugin-host`, `./loader`, `./consent`, `./audit`. Composite tsconfig with refs to `../types`, `../plugin-github`, `../plugin-jira` (for the credentials.ts client factory map + the plugin-resolver's dev-mode resolution scope).
- **A.5 — loader rewrite**: new `packages/core/src/plugin-resolver.ts` holds `BUILTIN_PLUGINS` map (`"github"` → `"@kuzo-mcp/plugin-github"` etc.) — hardcoded, NOT config-driven (security property per spec §A.5). `resolvePluginEntry(name, kuzoConfig)` tries installed-mode (`~/.kuzo/plugins/<name>/node_modules/<pkg>/`, overridable via `KUZO_PLUGINS_DIR` for the parity test) then falls back to dev-mode via `import.meta.resolve(pkg)`. Third-party plugins declare `packageName` in PluginConfig (new optional field on `@kuzo-mcp/types`). `loader.ts` calls `resolvePluginEntry()` + passes the URL through the IPC chain as `pluginEntryUrl` (not `pluginPath`). `plugin-process.ts` resolves the fork host via `fileURLToPath(import.meta.resolve("@kuzo-mcp/core/plugin-host"))`. `plugin-host.ts` takes the URL directly — dropped the `pathToFileURL()` wrapping because it's already a `file://`.
- **A.5 — extract 3 plugin packages**: `git mv src/plugins/<name>/** → packages/plugin-<name>/src/**` for all three. Each plugin declares `@kuzo-mcp/types` as BOTH `peerDependency` (publish-contract per §A.7 — avoids type-identity drift) AND `devDependency: workspace:*` (local dev — pnpm won't symlink peers with `strict-peer-deps=true` + `auto-install-peers=false`). `kuzoPlugin` metadata block on each (name, permissionModel, entry, minCoreVersion — inert until Part D).
- **A.6 — extract `@kuzo-mcp/cli`**: `git mv src/cli/** → packages/cli/src/**`. bundled into this commit (not a separate Step 6) because CLI files reached into plugin internals via `../../plugins/<name>/<file>.js` relative paths that would break in the interim between 5 and 6. New `packages/cli/package.json` owns the `kuzo` bin; subpath imports `@kuzo-mcp/plugin-github/{client,shared,types}`, `@kuzo-mcp/plugin-jira/{client,types}`, `@kuzo-mcp/core/{consent,audit}` across 7 files (pr.ts, repo.ts, review.ts, config.ts, consent.ts, jira.ts, ui/display.ts). `postbuild: chmod +x dist/index.js`.
- **A.7 — delete legacy `src/`**: gone after the moves. Root `tsconfig.json` flipped to solution-style (`{ files: [], references: [...] }` across all 6 packages). Root `package.json` stripped to dev-only deps + workspace scripts; dropped `bin`, dropped moved runtime deps (commander, inquirer, chalk, boxen, figlet, gradient-string, nanospinner, @octokit/rest, @modelcontextprotocol/sdk, zod-to-json-schema, dotenv, zod). `start:mcp` now `node packages/core/dist/server.js` (see tactical detail below).
- **ESLint ignore fix**: `dist/` → `**/dist/`, same for node_modules. Plain `dist/` only matched root in flat config.
- **Dotenv path depths** updated in `packages/core/src/config.ts` (repo root is 3 levels above `packages/core/dist/`) and `packages/cli/src/commands/config.ts` (4 levels above `packages/cli/{src,dist}/commands/`).

**A.9–A.10** (branch `phase-2.5e/step-9-10-ci-parity`, pending PR, 2026-04-15)

- **A.9 — cross-plugin ESLint rule**: added `no-restricted-imports` block to `eslint.config.js`, scoped via `files: ["packages/plugin-*/src/**/*.ts"]`, blocks patterns `@kuzo-mcp/plugin-*` + `@kuzo-mcp/plugin-*/**`. Core and CLI retain the ability to import plugin subpaths. Synthetic test (bad import in `plugin-jira`) fired the rule; full `pnpm run lint` still clean.
- **A.10 — dev-to-install parity test**: `scripts/test-install-parity.mjs` + `test:parity` root script. Flow: `pnpm build` → `pnpm pack` `@kuzo-mcp/types` + each plugin into a tmp `tarballs/` → for each plugin, `npm install <plugin-tarball> <types-tarball>` into `$TMPDIR/kuzo-parity-<ts>/plugins/<name>/` (yields the `KUZO_PLUGINS_DIR` shape the resolver expects) → spawn `packages/core/dist/server.js` with `KUZO_PLUGINS_DIR` + isolated `HOME` (so `~/.kuzo/audit.log` lands in the tmp dir) + `KUZO_TRUST_ALL=true` + real `GITHUB_*` from `.env` + fake `JIRA_*` (plugin.loaded fires at proxy-registration time before the child ever calls verifyConnection, so fake creds don't block the test) → MCP JSON-RPC handshake over stdio, `tools/list` contains all three plugins' canary tools, `tools/call get_git_context` + `tools/call get_repo_info` both succeed, audit log has `plugin.loaded` for all three. On success the workdir is removed; on failure it's left for debugging.
- **CI wiring**: new `parity` job in `ci.yml`, runs after `build`, writes a `.env` from `secrets.GITHUB_TOKEN` (default runner token — read scope is enough for `get_repo_info` on the current repo), then `pnpm run test:parity`. Added to `label-pr` and `ci-success` needs/conditions so branch protection covers it. Always-on per user call — not path-gated.
- **Surprise fix (same branch): 2.5a hardening timing**. Parity test surfaced a real bug: `Object.freeze(Object.prototype)` at startup breaks installed-mode plugins whose deps use TS-transpiled namespace IIFEs (zod v3.25.76's `errorUtil.js` does `errorUtil.toString = ...` on a plain `{}` — in strict ESM that throws because the inherited `toString` is now read-only). Dev mode hides this because the workspace hoists a single zod copy loaded before the freeze. `packages/core/src/server.ts` split `hardenRuntime()` into `installExitGuard()` (runs early) + `freezePrototypes()` (runs after `loader.loadAll()`). Plugin manifest imports now happen with mutable prototypes; the freeze still lands before the server serves any MCP request. `plugin-host.ts` (children) has never frozen prototypes and still doesn't — separate hardening gap for later.
- **Commit message plan**: three commits on the branch — (1) `feat(core): 2.5e A.9 — cross-plugin no-restricted-imports ESLint rule`, (2) `feat(core): 2.5e A.10 — dev-to-install parity test + CI job`, (3) `fix(core): defer prototype freeze until after loader.loadAll`. Single PR.
- **Green:** `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test:parity` all clean locally.

**Phase 2.5e Part C — pre-install provenance verification** (complete — PR #21, merged `d17fac9`, 2026-04-19)

- New `@kuzo-mcp/core/provenance` subpath export (`packages/core/src/provenance/{errors,policy,verify,index}.ts`). Pure library — no CLI wiring (Part D's job), no install scripts, no disk writes outside the Sigstore TUF cache.
- `verifyPackageProvenance(name, version, policy, opts) → Result<VerifiedAttestation>` mirrors `pacote/lib/registry.js` (the verifyAttestations path):
  1. `pacote.manifest()` resolves the packument (no install scripts).
  2. Fetches attestations via `dist.attestations.url`, host-rewritten to active registry through `joinRegistry()` helper that preserves any subpath prefix (Artifactory-style mirrors).
  3. Decodes each DSSE bundle's in-toto statement.
  4. For keyed (publish) attestations: fetches `<registry>/-/npm/v1/keys`, converts DER → PEM, validates that the key wasn't expired at the bundle's Rekor `integratedTime`.
  5. Subject check: `subject[0].name === pkg PURL` AND `subject[0].digest.sha512 === ssri-hex(integrity)`.
  6. `sigstore.verify(bundle, { tufCachePath, tufForceCache: true, keySelector? })` for every attestation.
  7. Applies `TrustPolicy` to the SLSA v1 statement → `{firstParty, repo, builder}`.
- `errors.ts`: 14 codes mapped onto exit codes 10–19 per spec §C.7. `ProvenanceError` class for try/catch consumers.
- `policy.ts`: `evaluate()` returns Result-style `PolicyResult`. `DEFAULT_POLICY = { allowedBuilders: ['https://github.com/actions/runner'], firstPartyOrgs: ['seantokuzo'], allowThirdParty: true }`. **`requireProvenance` field intentionally NOT in TrustPolicy** — Part D CLI will short-circuit before calling `verifyPackageProvenance` when `--trust-unsigned` is set, rather than threading the flag through the policy contract (cleaner layering).
- Bumped `@kuzo-mcp/core` `engines.node` to `^20.17.0 || >=22.9.0` (sigstore-js peer requirement). Repo-wide baseline still Node 20+; this is core-only.
- Pinned all 5 CI jobs to `node-version: '^22.9.0'` to satisfy the engines floor regardless of setup-node's bare `22` resolution.
- `scripts/smoke-provenance.mjs` + new `provenance` CI job exercise three real-npm scenarios against live Sigstore TUF + Rekor: `sigstore@4.1.0` permissive (third-party verified, 2 attestations), `sigstore@4.1.0` first-party-only (E_THIRD_PARTY_BLOCKED), `lodash@4.17.21` (E_NO_ATTESTATION). Wired into `label-pr` + `ci-success` required-checks. `pnpm test:provenance` runs locally (with auto `pnpm -s build` prefix).
- Deliberately deviates from spec on three small points (all called out in PR replies):
  1. `requireProvenance` removed from `TrustPolicy` (caller-layer decision).
  2. `@sigstore/verify` + `@sigstore/bundle` NOT direct deps — sigstore meta-package brings them transitively, and spec §C.10 #10 explicitly warns against using `@sigstore/verify` directly. `Bundle` type imported via sigstore's re-export.
  3. No cert-pinning (`certificateIdentityURI`) — pacote (gold standard) doesn't use it; SLSA policy already enforces builder + repo + org. Easy to add later if defense-in-depth wanted.
- 2 Copilot review rounds: 10 inline comments in round 1 (all addressed in commit `2eb19a2`), 0 in round 2 (LGTM). Round 2 needed explicit `@copilot review` PR comment trigger — auto-re-review didn't fire on push.
- ESM/CJS gotcha caught by smoke before commit: `import * as pacote from "pacote"` doesn't expose named exports at runtime in Node ESM (pacote is CJS, `module.exports = {...}`). Switched to `import pacote from "pacote"`.

**Phase 2.5e Part D.1 — plugin install CLI** (complete — PR #22, merged `7dec129`, 2026-04-20)

- New `kuzo plugins install <name>[@version]` subcommand tree wired into `@kuzo-mcp/cli`. Implements the full §C.1 install pipeline: verify via `@kuzo-mcp/core/provenance` → atomic stage to `~/.kuzo/plugins/<name>/.tmp/` → `pacote.extract` (with `ignoreScripts: true` + `integrity` pinning) → `npm install --ignore-scripts --omit=dev` for transitive deps → dynamic-import the manifest → delegate to 2.5c `ConsentStore.grantConsent` → rename `.tmp/` → `<version>/` → flip `current` symlink → upsert `~/.kuzo/plugins/index.json` with last-3 retention pruning.
- New files under `packages/cli/src/commands/plugins/`: `install.ts` (orchestrator), `state.ts` (`PluginsIndex` schema v1 + retention prune), `lock.ts` (exclusive `.lock` with `signal-exit` cleanup + stale-pid detection via `process.kill(pid, 0)`), `paths.ts` (canonical install paths, honors `KUZO_PLUGINS_DIR`), `index.ts` (Commander subcommand tree).
- Flags: `--version`, `--registry`, `--allow-registry` (npmjs.org-only gate per §C.9), `--trust-unsigned` (loud `boxen` warning), `--allow-third-party`, `--allow-builder <url>` (repeatable), `--dry-run`, `-y/--yes`. Removed `--allow-deprecated` during review — re-add when deprecation handling lands.
- `plugin-resolver` three-tier: versioned install (`<root>/<name>/current/pkg/`) → flat install (`<root>/<name>/node_modules/<pkg>/`, parity-test layout) → dev-mode `import.meta.resolve`. Parity test still green.
- `AuditLogger` gains `plugin.installed` action on `AuditAction` union. Audit emit is **post-commit only** — the trust-unsigned path no longer logs speculative "allowed" before consent. Verification-failure row uses `plugin: friendlyName` with npm package name in `details.packageName`.
- Exit codes: 10–19 from provenance domain (spec §C.7), 30 for lock contention, 40–49 reserved for install-domain errors (`E_INVALID_SPEC`, `E_UNSUPPORTED_REGISTRY`, `E_EXTRACT_FAILED`, `E_DEPS_INSTALL_FAILED`, `E_NO_ENTRY_POINT`, `E_MANIFEST_LOAD_FAILED`, `E_NO_DEFAULT_EXPORT`, `E_LEGACY_MANIFEST`, `E_NAME_MISMATCH`, `E_VERSION_MISMATCH`).
- CLI deps: `pacote@^21.5.0`, `signal-exit@^4.1.0`, `@types/pacote` (dev).
- Config-file mutation deferred per spec §D.5 MVP recommendation: install prints a reminder `Add { enabled: true } under plugins.<name> in kuzo.config.ts, then restart`. No AST/`ts-morph` edit.
- **Copilot review:** 1 round, 8 inline comments in round 1 (all addressed in commit `55fa650`). Round 2 trigger via `@copilot review` PR comment → Copilot replied as PR comment (not a formal review) confirming all 7 fixes + 1 non-blocking UX nit about the `--registry` help string. Merged per `<5` comment threshold.
- **TOCTOU fix from Copilot r1:** pre-fix, `stageTarball` re-resolved `${pkg}@${versionSpec}` via `pacote.extract`, which could hand us a different tarball than `verifyPackageProvenance` just verified if `versionSpec` was `latest` or a range. Post-fix, all post-verify calls use `verification.package.version` + `verification.package.integrity` — pacote rejects a tarball whose hash doesn't match.
- **Peer-dep smoke takeaway:** bootstrap-tagged `@kuzo-mcp/plugin-git-context` DOES declare `@kuzo-mcp/types` as peer (verified during review fix), but the peer target `^0.0.1` doesn't yet exist on npm. So `plugins install --trust-unsigned git-context@0.0.0-bootstrap.0` still hits `ETARGET` until the canary release of `@kuzo-mcp/types`. My stage-with-peer-deps fix is correct; the registry state is the remaining blocker.

**Phase 2.5e Part D.2 — list / uninstall / refresh-trust-root** (complete — PR #24, merged `a838e70`, 2026-04-21)

- Three new `kuzo plugins` subcommands under `packages/cli/src/commands/plugins/`: `list.ts` (read-only, no lock), `uninstall.ts` (lookup by friendly name OR packageName → rm plugin dir → remove index entry → `ConsentStore.revokeConsent` → audit; `--keep-versions` preserves version dirs on disk), `refresh-trust-root.ts` (wipes `~/.kuzo/tuf-cache/` + `~/.kuzo/attestations-cache/`, missing dirs are no-ops; plugin field in audit is the sentinel `"system"`).
- `list` renders a 5-column padded table (Name · Version · Source · Integrity (20-char prefix) · Installed YYYY-MM-DD). `--json` dumps the raw `PluginsIndex`. Headers + rows pad BEFORE chalk coloring — coloring-then-padding breaks alignment on a TTY because ANSI codes count toward `String.prototype.length`.
- `uninstall` exits 47 with "not installed / Installed: x, y" hint when the name doesn't match. `--keep-versions` still removes the index entry and revokes consent — only the retained version dirs stay.
- `AuditAction` union extended with `"plugin.uninstalled"` and `"plugin.trust_root_refreshed"`.
- **Round-1 cleanup — `acquireLockOrExit` anti-pattern removed**. D.1's `install.ts` used a helper that swallowed `PluginsLockedError` and called `process.exit(30)` internally, which made the `PluginsLockedError` branch in `exitCodeForError` dead code and leaked process termination into business logic. D.2 drops the helper from all three files (install, uninstall, refresh-trust-root) and calls `acquireLock(command)` directly; `PluginsLockedError` now bubbles to the Commander action's `exitCodeFor*Error` mapper for consistent exit-30 handling. Verified with a manually-held lock.
- **D.1 round-1 UX carry-over landed**: `--registry <url>` help text now explicitly mentions that non-npmjs.org URLs require `--allow-registry <url>`.
- **Copilot review:** 1 round, 5 inline comments in round 1 (all addressed in commit `3595a3e`). Round 2 LGTM — returned as a PR issue comment from user login `Copilot` (capital C, no `[bot]` suffix) confirming all 5 fixes and CI green.
- No new dependencies. No config-file mutation. `kuzo.config.ts` edit remains a printed reminder on uninstall, mirroring install's posture.

**Phase 2.5e Part D.3 — update / rollback / verify** (complete — PR #25, merged `a316c9d`, 2026-04-21)

- Three new `kuzo plugins` subcommands complete the install CLI surface. `update [name]` (single or all installed), `rollback <name> [version]` (n-1 default or explicit retained version), `verify <name>` (read-only re-verify against cached evidence).
- **Refactor up front**: extracted `staging.ts` (stageTarball, cleanupStaging, loadStagedManifest, loadVersionedManifest), `verification-cache.ts` (read/write per-version `verification.json` with schema guard + policySnapshot + policiesEqual), `summary-card.ts` (confirm, printSummaryCard, printCapabilitySummary, formatCapabilityShort, printCapabilityDiff) from install.ts. install.ts shrank from ~780 → ~410 lines.
- **D.1 bug fixed in D.3**: install.ts D.1 wrote `verification.json` WITHOUT `policySnapshot`, but spec §C.8 requires it for cache invalidation. Now writes it. Older D.1/D.2 entries load fine (field is optional); `verify` treats missing snapshot as forced cache miss and backfills on next re-verify.
- **`update`**: per-plugin `pacote.manifest(@latest)` → skip-if-same → Part C verify → stage tarball → diff new manifest's capabilities against `ConsentStore.getConsent(name)` (subset/equal refreshes `pluginVersion` silently; added/removed surfaces `+/-` diff + re-prompt). Declined plugin skipped, loop continues. Atomic commit reuses install's staging→version rename. Emits `plugin.updated` audit, prints `{ updated, skipped, failed }` summary. Lock acquired BEFORE `readIndex()` for non-dry-run (closes uninstall→resurrect TOCTOU).
- **`rollback`**: default target `retainedVersions[1]`; explicit version must be in retained AND on disk. Re-consent against target manifest (rollback is NOT implicitly safer than upgrade). Commit under lock: re-read index, index-first / symlink-second with best-effort `revertIndex` on symlink failure. Does NOT re-verify provenance — target was verified at original install (use `verify` after rollback if paranoid). Missing n-1 → exit 20 per spec §D.4.
- **`verify`**: read-only, no lock, no audit. Reads `verification.json`; if `policySnapshot` equals active TrustPolicy (via sorted-array compare + boolean match), prints cached evidence. Else (mismatch / missing / `--no-cache`) re-fetches attestations, re-runs `sigstore.verify()`, rewrites cache.
- `AuditAction` union extended with `plugin.updated` + `plugin.rolled_back`. `@kuzo-mcp/core/consent` now also exports `capabilityKey` + `diffCapabilities(next, prev) → { added, removed }`.
- **Exit codes added:** 20 (`E_NO_RETAINED_TARGET`), 48 (`E_NOT_INSTALLED`), 49 (`E_PARTIAL_FAILURE` — multi-plugin update), 50 (`E_RESOLVE_FAILED`), 51 (`E_VERSION_DIR_MISSING`), 52 (`E_VERSION_NOT_RETAINED`), 53 (`E_ALREADY_CURRENT`). All three commands honor the shared `STAGING_ERROR_EXIT_CODES` (42-44) via staging.ts.
- **Bonus latent-bug fix**: `install.ts`'s `resolveRegistry` had `requested = options.registry ?? options.allowRegistry`, letting `--allow-registry <url>` act as a selector instead of a gate. Fixed in all three commands (install/update/verify) to read `options.registry` only.
- **Windows portability**: `verification-cache.ts` uses `path.join` + `path.dirname` instead of string concat + regex slice (flagged by Copilot round 1).
- **Copilot review:** 1 round, 11 inline comments in round 1 (all addressed in commit `2eeadfe`; round landed on top of a trivial style-fix commit `5379080` from `copilot-swe-agent[bot]` — style fixes from that bot were subsumed by the full fix commit). Round 2 LGTM — returned as a PR issue comment from user `Copilot` confirming all 11 fixes + flagging one non-actionable observation about predicateTypes element typing (intentional scoping per "validate exactly what callers dereference"). Merged per `<5` threshold.
- No new dependencies.
- **End-to-end smoke gap**: full install → update → rollback against real npm remains gated on `@kuzo-mcp/types@0.0.1` canary release. Until then, coverage is typecheck + lint + build + parity test + CLI help text + E_NOT_INSTALLED / empty-index code paths. **CLOSED 2026-05-03 — see "First real release" entry below.**

**Phase 2.5e — First real npm release** (complete — 2026-05-03)

The first real release shipped after a 4-PR fixup saga uncovered three real bugs in the release pipeline that had been latent through all of Phase 2.5e because the end-to-end smoke had been (correctly) gated on having a published canary.

- **PR #27 (`fix(ci): bump npm to 11`) — Trusted Publishing was silently 404ing.** Every Release workflow run on main since Phase 2.5e Part B had failed with 404 on PUT, but only Sean's manual look at the run log surfaced it. Root cause: TP requires npm ≥ 11.5.1 (per npm's own docs); `release.yml` had pinned `npm install -g npm@10.9.2`, a pre-TP version. npm 10.9.2 falls back to setup-node's placeholder `NODE_AUTH_TOKEN=XXXXX-XXXXX-XXXXX-XXXXX` which the registry rejects with a masked 404 (auth failure shown as not-found, not 401). Sigstore provenance signing kept succeeding throughout (that's a `--provenance` feature available since npm 9.5), which made the failure look like a registry/TP-config issue rather than a CLI version issue.
- **PR #28 (`fix(ci): bump Node to 24`) — npm in-place self-upgrade is broken.** PR #27's `npm install -g npm@11` died at runtime with `MODULE_NOT_FOUND: 'promise-retry'`. Classic npm self-upgrade footgun: npm removes its own internal deps mid-install and can't finish. Pivoted to bumping Node 22 → 24 in `release.yml` and dropping the explicit upgrade step. Node 24.15.0 ships with npm 11.12.1 natively (verified via `https://nodejs.org/download/release/index.json`). After this merged, the publish ran clean: all 6 `@kuzo-mcp/*@0.0.1` published with attestations.
- **PR #29 + #30 (`fix(plugins): derive manifest version from package.json` + `chore(release): version packages`) — manifest version drift.** First successful 0.0.1 publish surfaced a real bug at `kuzo plugins install git-context@0.0.1`: Sigstore verified end-to-end (`first-party, 2 attestations`), `pacote.extract` succeeded, transitive deps installed, then **`✗ Plugin manifest declares version=1.0.0; npm says 0.0.1`**. Every plugin had `version: "1.0.0"` hardcoded in its `KuzoPluginV2` manifest. The install CLI's D.3 `E_VERSION_MISMATCH` check correctly refused to commit. Fix: each plugin's `index.ts` now derives version via `createRequire(import.meta.url)("../package.json")` (universal Node 16+, no flag dance). Chose createRequire over `with { type: "json" }` (Node 22+ stable, 20.x needs `--experimental-import-attributes`) and over `assert { type: "json" }` (deprecated per current ECMAScript spec). Bumped 5 packages to `0.0.2` (`@kuzo-mcp/{cli,core,plugin-git-context,plugin-github,plugin-jira}`); types stayed at `0.0.1` because types is upstream of plugins — `updateInternalDependencies: "patch"` cascades downward (consumer gets bumped when its dep bumps), and the `linked: [["@kuzo-mcp/types","@kuzo-mcp/core"]]` rule only triggers on explicit changesets, not on cascade-induced bumps.
- **Mid-release repo-setting block.** PR #30's first Release workflow run pushed the `changeset-release/main` branch successfully then failed at PR creation: `HttpError: GitHub Actions is not permitted to create or approve pull requests`. Repo setting fix: **Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"** must be enabled for changesets/action's Version PR flow. After flipping it, `gh run rerun <id> --failed` re-fired the workflow which opened PR #30 cleanly.
- **Live e2e smoke verified (2026-05-03):** `kuzo plugins install git-context@0.0.2 -y` → `✔ Verified ... (first-party, 2 attestations)` → atomic commit. `kuzo plugins list` shows the row. `kuzo plugins verify git-context` returns cached evidence (policySnapshot match → cache hit). All three commands functioning end-to-end against the real npm registry, real Sigstore TUF cache, real Rekor lookups.
- **Sean's parallel work (PRs #31 + #32):** added a Claude Code GitHub workflow and a Claude multi-tier auto-review system. Not part of the release fix chain but landed in the same window.

### ⏭️ Fresh-session handoff — when user says "next"

**Phase 2.6 credentials spec is implementation-ready as of 2026-05-12 (PR #41 merged).** `docs/credentials-spec.md` (~3220 lines) absorbed all round-1/round-2/round-3 advisories plus round-4's 15 BLOCKING + 13 ADVISORY findings from an independent multi-reviewer pass (Security / Architecture / Correctness specialists, blind to each other). Round-4 caught 5 spec-contradicts-code claims that prior rounds missed (`kuzoPlugin.capabilities` not in plugin `package.json` files; `server.ts` self-invocation guard absent; `PluginRegistry` constructor missing arg; `clientFactories` module-level singleton; `AuditLogger` concrete class vs interface) plus 3 novel security gaps (no capability env-naming policy; `fs.watch` detached by atomic-rename; child→parent audit IPC unbounded). Spec sections added: §A.0.1 (manifest contract), §A.12 (strict per-plugin env reservation), §C.10.1 (audit rate-limit + rotation). Disposition documented section-by-section in `docs/credentials-spec-round4-notes.md`. Round-3 + round-4 notes both in-tree for cross-reference during implementation; deleted at phase-close per issue #39.

**Bookkeeping landed:** PR #42 (max-turns bump) merged 2026-05-15. PR #41 (round-4 spec) merged 2026-05-12. Pre-1.0 versioning cadence codified in `CLAUDE.md` + `PLANNING.md` on 2026-05-19 — patch bumps only until the post-QA "trusted for daily use" 0.1.0 milestone.

**Locked next-session plan (updated 2026-05-23):**

0. ~~**Theme 0 / build-order step 0 — manifest bake.**~~ ✅ Complete via PR #43, merged 2026-05-20 (`ede2eb4`). 2 rounds, judge merge HIGH. Static `kuzoPlugin.capabilities` + `optionalCapabilities` baked into all 3 first-party plugin `package.json` files mirroring runtime `KuzoPluginV2.capabilities`. New `scripts/check-plugin-manifest-parity.mjs` deep-equals static vs runtime (key-sorted stable stringify, array order preserved). Wired BOTH as per-plugin `postbuild` AND as a root `check:manifest` script chained into `pnpm build` (round-1 Correctness blocker: `tsc -b` bypasses per-package lifecycle hooks, so per-plugin postbuild alone wouldn't fire in CI/release). Drift gate now fires from every `pnpm build` invocation. **Divergence from the original handoff:** `postbuild` not `prebuild` — script needs the compiled `dist/index.js`, so it must run after `tsc`. **Deferred per the original step's "for simplicity" carve-out:** the `FIRST_PARTY_ENV_RESERVATIONS` map / `env-namespace.ts` lives in Theme 7 (credentials CLI), not Theme 0. Spec acceptance line 2932 satisfied: synthetic drift edits cause `pnpm --filter @kuzo-mcp/plugin-X build` AND root `pnpm build` to exit non-zero with field-by-field diff.

1. ~~**Theme 1 — `KUZO_HOME` + shared `packages/core/src/paths.ts`.**~~ ✅ Complete via PR #45, merged 2026-05-21 (`9c8149c`). 3 rounds, all ship across all 3 specialists every round; impartial judge sub-agent called merge HIGH confidence on round-3. New `packages/core/src/paths.ts` exports the 8 §E.2-specified helpers (`kuzoHome`, `pluginsRoot`, `credentialsFilePath`, `consentFilePath`, `auditFilePath`, `tufCacheDir`, `attestationsCacheDir`, `kuzoHomeLockPath`) via the `./paths` subpath on `@kuzo-mcp/core`. 7 sites refactored (consent / audit / plugin-resolver / plugin-process / provenance/verify / CLI plugins/paths.ts / refresh-trust-root). ESLint `no-restricted-syntax` rule covers all 6 drift shapes (3 syntactic forms × named/namespace import). Sandbox-arg hardening: `kuzoHome()` rejects empty-string and `,`/`\n`; `assertNoFsArgInjection()` applied to both arms of `--allow-fs-read=` interpolation. Zero behavior change at defaults. **Round 2 pushback (documented inline):** the 4 file-path helpers (`credentialsFilePath`, `consentFilePath`, `auditFilePath`, `kuzoHomeLockPath`) are pre-positioned per locked §E.2 contract — `credentialsFilePath` consumed in Theme 2, `kuzoHomeLockPath` in Theme 6/8. **Round 3 carry-over → issue #46** (sweep in Theme 2 PR before any credentials writes): assert `kuzoHome()` fallback branch (`homedir()`) for fs-arg injection (defense-in-depth; L161 plugin-process comment currently overclaims), drop dead `kuzoHome` re-export in CLI `plugins/paths.ts`, JSDoc drift sweep in audit/consent/verify.

2. ~~**Theme 2 — Storage primitives.**~~ ✅ Complete via PR #47, merged 2026-05-22 (`df6875d`). 2 rounds, judge merge HIGH. Issue #46 sweep landed in `8bd9d7b` as the first commit on the same branch. New `packages/core/src/credentials/` (cipher / errors / key-provider / testing / store / index + 58 tests) lands the §A.1–A.5 surface. `@napi-rs/keyring@1.3.0` exact-pinned in core deps per spec §A.9 Tier 1. Two subpath exports (`./credentials` for production, `./credentials/testing` for the InMemoryKeyProvider test double — public-surface separation is the primary defense once Theme 4 wires `chooseKeyProvider()`). AuditAction extended with 3 lifecycle variants; write-side variants deferred to Theme 5/6 per §0 build order. **Round-1 dispositions:** (a) test-double exposure → moved to `./credentials/testing` subpath in `da6357a`; (b) tests-not-typechecked (`exclude` regression in tsconfig.json) → reverted + `files` negation in `da6357a`; (c) mode-method coupling at runtime → pushed back as won't-fix (closed 4-provider set, runtime guard + JSDoc adequate, not re-raised in round 2); (d) cosmetic JSDoc rot → softened in `e836d6e`. **Workflow infra carry-over → issue #48** (Tier 3 deep review failed bot-allowlist check; secondary observation about Correctness sentinel under-counting documented in same issue). **Pre-Theme-2-merge issue #46 sweep landed cleanly:** `kuzoHome()` fallback now self-validates fully; dead CLI re-export dropped; JSDoc drift swept in audit/consent/verify constructor-option docstrings.

3. ~~**Theme 3 — A.6–A.7 CredentialSource + env-override collection.**~~ ✅ Complete via PR #49, merged 2026-05-22 (`2ee5080`). 1 round, judge merge HIGH. Clean ship/0/0 across all 3 Tier 2 specialists; zero inline review comments. Tier 3 auto-escalated on large-diff (>500 lines) — label actually applied this time, BUT all 4 deep specialists + the Deep synthesizer hit issue #48's bot-allowlist infra failure (NOT a Tier 3 verdict — physical workflow failure). New `packages/core/src/credentials/source.ts` + `env-overrides.ts` (35 KB across two files) land the §A.6–A.7 surface as pure logic — no I/O, no boot wiring, no loader changes (Theme 4 consumes both). Round-4 fixes verified in-source: B4 (no schema change to `CredentialCapability`; required/optional captured by manifest array, not `optional?` field), A2 (`ALWAYS_SCRUB` includes `KUZO_NO_ENV_SCRUB` so plugin children can't observe the kill-switch), N1 (prefix-delete sweep skips ALWAYS_SCRUB), B11 (`auditLogger` threaded as function argument, not constructor), B8 (`isCredentialCapability` type guard added to `@kuzo-mcp/types` mirroring `isV2Plugin`). `AuditAction` extended with `credential.scrub_disabled` only — write-side variants still deferred to Theme 6/7. 39 new node:test cases (97 total credential tests, 100% pass via `pnpm test:credentials`). Security-lane tripwire recorded inline for Theme 4 reviewer: `collectEnvOverrides` trusts that `declaredEnvNames` has been Theme-7-§A.12-sanitized, so Theme 4 boot MUST NOT call it against unsanitized manifest input — production defense is the Theme 7 reservation gate.

4. ~~**Theme 4 — C.1–C.3 + C.9 — boot sequence rewrite + self-invocation guard + child_process ESLint rule.**~~ ✅ Complete via PR #50, merged 2026-05-23 (`5f43f06`). 4 rounds, judge merge HIGH at the hard cap. All 4 rounds: SHIP with 0 blocking. Verdict trend 0/7 → 0/3 → 0/4 → 0/3. Round-1 SEC catch is the load-bearing fix: narrowed `scrubProcessEnv` keys from `[...declaredEnvNames, ...Object.keys(envOverrides)]` to `[...declaredEnvNames]` only — closed the `KUZO_TOKEN_PATH=evil` → `delete process.env.PATH` attack. Self-invocation guard, KeyProvider selection (§A.5 precedence: `KUZO_DISABLE_KEYCHAIN` + `KUZO_PASSPHRASE` → Passphrase; alone → Null; `KUZO_PASSPHRASE` alone → Passphrase; else Keychain), `RESERVED_KUZO_ENV` runtime safety net (10 kuzo-internal env names — defense-in-depth; Theme 7 §A.12 install-time gate is canonical), `child_process` ESLint ban widened to `packages/core/src/**/*.ts` minus `plugin-process.ts` + `paths.ts` (`allowTypeImports: true` lets `ipc.ts` keep `import type { ChildProcess }`), `ConfigManager.extractPluginConfig` deleted per §C.7. Loader takes `CredentialSource` as 6th constructor arg; call-site swap uses `isCredentialCapability` filter. Parity test stays green end-to-end. Pushbacks documented in PR comments: changeset cadence batches at phase close (not per-Theme), `node:` prefix convention drift (new files match dominant 32 vs 14), ESLint dynamic-import coverage gap (Theme 7 boundary), plugin-name path-traversal (Theme 7 install CLI is the surface). Tier 3 hit issue #48 bot-allowlist again. Round-4 verdict synthesizer crashed on `actions/checkout@v4` git auth — separate CI infra glitch on the synth job only; all 3 specialists shipped.

5. ~~**Theme 5 — C.10 + C.10.1 — Plugin-host audit emissions over IPC + rate-limit + log rotation.**~~ ✅ Complete via PR #51, merged 2026-05-23 (`026fcc0`).

6. ~~**Theme 6 — C.4–C.6 — Broker write-side audit slots + shutdown hooks + retire `clientFactories` singleton.**~~ ✅ Complete via PR #53, merged 2026-05-24 (`fd580de`). 4 rounds, impartial judge merge HIGH at the hard cap. Verdict trend SHIP 0/2 → 0/5 → 0/1 → 0/2 — zero blocking across all 4 rounds, every advisory addressed (round-1 construction-time first-party reservation guard, round-2 sticky-close + try/finally broker scrub + cast nit, round-3 third-party factory JSDoc clarification, round-4 cast removal + lock-once-per-instance contract docs). 1 pushback held (R2 Architecture `static forTesting()` refactor — R1 construction guard already structurally enforces reservation invariant, refactor would change access surface without changing security posture). Synth crashed in R3 AND R4 (same gotcha class as Theme 4 R4 + Theme 5 R3); 3 specialist sentinels carried the signal across both rounds. 7 new parent-only `AuditAction` write-side slots reserved (`credential.set/.deleted/.rotated/.migrated/.migration_partial/.wiped/.tested`) — Theme 7/8 wire the producers via `kuzo credentials *` CLI surface. `clientFactories` Map retired from module scope to per-instance state; `registerClientFactory` on `CredentialBroker` interface enables third-party plugin extension while first-party names are double-locked at construction + runtime. `DefaultCredentialBroker.shutdown()` wired into `plugin-host.handleShutdown` inside try/finally. `EncryptedCredentialStore.close()` audit reshape with sticky `hasEmittedClose` flag preventing double-emit on signal-handler + idempotent teardown patterns. 113 credentials tests pass (97 prior + 14 broker + 2 store-close). 4 rounds, impartial judge merge HIGH at the hard cap. Verdict trend: SHIP 0/5 → SHIP 0/7 (5 unique) → SHIP 0/6 → fix-then-ship 1/5 — round-4 raised one BLOCKING Security finding (child-supplied `timestamp` smuggling via spread order in `FileBackedAuditLogger.log` + `decideAudit`'s `{...event}` spread of untrusted wire) that was fixed in `4c6caa4` via explicit-field construction in both `decideAudit` AND `FileBackedAuditLogger.log` (timestamp-after-spread). 4 new `AuditAction` variants (`audit.forged_plugin_field` / `.forged_action` / `.rate_limited` / `.partition_initialized`); `Record<AuditAction, "parent-only" | "child-permitted">` exhaustiveness check in `audit-partition.ts`; rate-limit + wire-shape + byte-cap gauntlet at the IPC entry (rate-limit consumes BEFORE wire validation so malformed / oversize / forged all count toward the bucket); `FileBackedAuditLogger` rotation at 50 MiB (5 retained, atomic rename only); `query()` globs across `audit.log` + `audit.log.{1..5}`; `mkdirSync` mode `0o700`; `appendFileSync` mode `0o600`; `safeStringify` never-throw envelope; `node:fs`/`node:path` prefix throughout. ESLint `plugin-host{*,/**/*}.ts`-scoped block bans `appendFile*` from `node:fs` + `fs/promises` + namespace-import bypass via `*.appendFile*` selector, plus `FileBackedAuditLogger` named import (relative + subpath). 47 new `node:test` cases via new `test:audit` script (31 audit-ipc + 16 misc) chained into `pnpm test`. **Pushbacks:** changeset cadence (phase-close batching, not per-Theme), forgery-flood retention erosion → **issue #52** (spec divergence — aggregating diverges from §C.10 per-attempt emission), relative-import bypass via hypothetical `plugin-host/` subdir (forward-compat, `files:` glob already widened). Round-3 synth crashed on its 30-turn cap (new gotcha distinct from Theme 4's checkout-auth glitch); all 3 specialists posted clean JSON sentinels and the fix landed without a synthesized sticky.

7. **IMMEDIATE NEXT — Themes 7–9 onwards** per the spec's §0 build order:
   - Theme 7: B.1–B.3 + A.11 + A.12 — `kuzo credentials set/list/delete/rotate/status/test/wipe` + state machine + strict env-name reservation install-time validation. **Pre-positioned reservations** to widen `RESERVED_KUZO_ENV` into Theme 7's canonical `FIRST_PARTY_ENV_RESERVATIONS` + `RESERVED_SYSTEM_ENVS` install-time gate. Also addresses the Theme 4 round-4 deferred advisories (ESLint dynamic-import coverage gap + plugin-name path-traversal hardening — both belong with the install CLI surface). Theme 6 reserved the 7 write-side audit slots that these commands will produce.
   - Theme 8: B.4 — `kuzo credentials migrate` (HIGHEST-RISK PR — symlink-safe + dotenv parser + step-3-substep ordering + read-back-verify + post-rewrite redaction-verify + storeSnapshot rollback per round-1/2/4 advisories).
   - Theme 9: D.1–D.3 + C.11 — `kuzo serve` bin + **directory-watch** rotation cache invalidation (round-4 B14 — watch dirname not file). Also wires the `--no-scrub` CLI flag through `RunServerOptions.scrub`; reuses Theme 4's existing `credential.scrub_disabled` audit emit with a more specific reason. **Theme 4 round-2 deferral applies here:** the user-facing flag should be gated behind `KUZO_DEV=1` or interactive confirm, not exposed as a vanilla `--no-scrub`.
   - Phase close: docs + canary release. **Patch bumps across the board per the pre-1.0 cadence in `CLAUDE.md` / `PLANNING.md`** — types `0.0.1 → 0.0.2`, core/cli/plugins `0.0.2 → 0.0.3`. NOT 0.1.0 — we're still pre-QA. The `runServer` / `RunServerOptions` new public API and the `AuditLogger` rename get a CHANGELOG callout. First `0.1.0` is reserved for the post-QA "trusted for daily use" moment after we run `kuzo serve` for a stretch.

   Acceptance criteria in §F.1 are extensive — ~100 checkbox items covering all parts. Per-step build-greenness: `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test:parity` must remain clean.
2. **AFTER IMPLEMENTATION LANDS — Phase 2.6 phase-close.** Update `SECURITY.md` §6, `PLANNING.md`, this file, `README.md` per §F.3 step 9. Delete `docs/credentials-spec-round{3,4}-notes.md` (closes issue #39). Cut coordinated release for all 6 packages.
3. **AFTER CREDENTIALS SHIP — Real-life QA via Claude Code.** Hook up the published `@kuzo-mcp/cli` as an MCP server in `~/.claude/settings.json`. Use across normal daily work for a stretch — natural QA. File issues for whatever surfaces. NO new feature work; just bake-time on the published artifacts. Now actually viable because the user can provision credentials via the documented `kuzo credentials set` flow instead of hand-editing settings.json env blocks.
4. **AFTER QA SETTLES — AppleTV plugin.** See memory `project_appletv_plugin.md`. First session is research-heavy: Node.js library landscape (pyatv-equivalent? native MediaRemote/MRP?), MCP tool surface (remote, now-playing, search, app launch, screenshot), capability profile (network: LAN; credentials: pairing token), plugin spec mirroring the github/jira decompositions. Build it as `@kuzo-mcp/plugin-appletv` following the locked decisions (pnpm workspaces, scoped name, KuzoPluginV2 manifest, version derived from package.json via createRequire).
5. **AFTER APPLETV SHIPS — Hosted deployment + Claude.ai custom connector.** AppleTV is the forcing function: Sean wants AppleTV control from Claude.ai mobile, which only works if the MCP server is reachable remotely. Get the server running cheaply somewhere (Fly.io / Railway / Cloudflare). Add a thin SSE/HTTP transport adapter on top of `@kuzo-mcp/core` (current stdio transport is local-only).
6. **AFTER HOSTING — Plugin expansion wave.** Build out more integrations and fill gaps in existing plugins. Driven by what Sean actually uses day-to-day rather than a pre-planned "Phase 3" scope. This is the long-tail expansion work — no defined scope yet.

**On a fresh session, when user says "next":**

1. **Start at Theme 7 — B.1–B.3 + A.11 + A.12 — `kuzo credentials set/list/delete/rotate/status/test/wipe` + file state machine + strict env-name reservation install-time validation.** Read `docs/credentials-spec.md` §B.1 + §B.2 + §B.3 + §A.11 + §A.12, plus §C.4 for the broker `registerClientFactory` contract that Theme 6 landed (third-party plugins consume it from `initialize()`). Open a new branch `phase-2.6/credentials-cli` (or per-Theme convention).

   **Build-order context:** Theme 6 (broker write-side audit slots + clientFactories retirement + shutdown hooks) just landed in `fd580de`. The 7 write-side `AuditAction` variants are reserved and classified parent-only in `audit-partition.ts`; Theme 7 wires the producers. The `EncryptedCredentialStore.close()` audit lifecycle + `wipeKeyCache` master-key zero + sticky-emit invariant are all in place — the CLI commands construct short-lived `EncryptedCredentialStore` instances per command and rely on these primitives. The `DefaultCredentialBroker` instance-state refactor matters for any future test harness that needs to construct brokers without first-party preloads (use the `clientFactories` constructor option — construction-time guard prevents reserved-name laundering).

   **Theme 7 surface (high-level — read the spec for exact shape):**

   1. **CLI commands (spec §B.1–B.3).** `kuzo credentials set <name>` / `list` / `delete <name>` / `rotate <name>` (alias for set, emits `credential.rotated` not `credential.set`) / `status` / `test <name>` / `wipe --confirm`. Each command instantiates an `EncryptedCredentialStore` (parent-eager decrypt during command lifetime), mutates via `set` / `delete`, emits the Theme-6-reserved write-side audit variant, and closes the store on command exit (sticky-close-emit fires once per command).

   2. **File state machine (spec §A.11).** Five canonical states — `FRESH` (no file, no key), `FRESH_WITH_KEY` (keychain entry survived an out-of-band file delete), `LOCKED` (file present + keychain present, awaiting unlock), `UNLOCKED` (cache populated), `KEY_LOST` (file present but keychain missing). Each CLI command identifies the current state via `EncryptedCredentialStore.isUnlocked()` / `keyProvider.getGeneration()` and either transitions or surfaces a recovery message.

   3. **§A.12 strict env-name reservation install-time validation.** Widen the Theme 4 `RESERVED_KUZO_ENV` runtime denylist into the canonical install-time gate. New `FIRST_PARTY_ENV_RESERVATIONS` map (per spec §A.12.1 — `GITHUB_*` → `@kuzo-mcp/plugin-github`, `JIRA_*` → `@kuzo-mcp/plugin-jira`) + `RESERVED_SYSTEM_ENVS` set (PATH / HOME / NODE_* / etc.) + local namespace registry (spec §A.12.2). Install-time validation order per §A.12.3 — third-party plugins that declare env names colliding with first-party reservations or system reserved names FAIL to install with a clear remediation message.

   4. **Theme 4 round-4 deferred advisories** also land here per the existing handoff: (a) ESLint `child_process` dynamic-import coverage gap (extend the `no-restricted-syntax` rule to catch `import("node:child_process").then`, `createRequire(import.meta.url)("node:child_process")`, aliased identifier dynamic imports); (b) `resolvePluginPackageDir` name validation regex (`/^[a-z][a-z0-9-]{0,62}$/`) at the install CLI entry point + `resolvePluginEntry` + `resolvePluginPackageDir` itself.

   5. **`AuditAction` consumption.** Each command emits one of the Theme-6-reserved write-side variants from the parent CLI (`credential.set` / `.deleted` / `.rotated` / `.tested` / `.wiped`). NONE of these are emitted from the in-child broker — they MUST stay parent-only per `AUDIT_ACTION_PARTITION`. The CLI is in the parent, so this is structurally enforced.

   **Acceptance criteria (spec §F.1 relevant subset for Theme 7):** consult the spec §F.1. Tests should cover state machine transitions, env-name install-time validation gate behavior, and per-command audit emission shape.

   **Quality gate:** `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test:audit && pnpm test:credentials && pnpm test:parity` all clean.

   **Pre-Theme-7 carryover from Theme 6 round-2:**
   - The pushback on the Architecture lane's `static forTesting()` refactor suggestion was: R1 construction-time guard already structurally enforces the reservation invariant. If Theme 7's CLI commands need test isolation that the existing `clientFactories` option doesn't cleanly provide, revisit; otherwise the current shape is locked.

   **Pre-Theme-7 carryover from Theme 5:**
   - `eslint.config.js` `no-restricted-imports paths:` block matches literal `./audit.js`; if Theme 7 introduces any new file in a hypothetical `plugin-host/` subdir, switch to `patterns:` regex for the import side. Currently deferred — `files:` glob already widened.
   - **Issue #52** (forgery-flood retention erosion) — spec §C.10 emits per-attempt forgery records by design; if Theme 7's CLI surface ever touches the retention budget or rotation policy, evaluate whether aggregating forgery emissions becomes worthwhile.

2. **Continue Theme 8+ onwards** per the build order above. Each Theme is its own PR; the Theme 8 migrate PR ships alone with extra reviewer focus per round-4 advisory.

**Round-2+ auto-review is manual workflow_dispatch on this project** (per `feedback_round2_dispatch.md` memory + `.github/workflows/claude-code-review.yml` header). After pushing a fix, run `gh workflow run claude-code-review.yml --ref <branch> -f pr_number=<N> -f specialist=all` to fire the next round. Single-specialist runs skip the synth → no round-N sticky; use `all` when you need the judge to read a sticky.

Spec is locked; no more spec revision. The implementation just executes the spec section-by-section.

**Round-3 takeaway** (load-bearing context for any implementation work): the broker lives in the CHILD process per 2.5d isolation (`plugin-host.ts:114`). Parent-eager decrypt is the locked model — parent decrypts at boot when any plugin needs the store (during `loader.loadAll()`, not on first tool call); zero prompts if env overrides satisfy everything. Per-plugin Map ships to children via IPC. Child has no `KeyProvider`. Every credential-adjacent design choice flows from this.

**Round-1 + round-2 review takeaways** (load-bearing for implementation):
- **C.10 audit IPC routing MUST land before any write-side credential.* events** (the four read-side broker emissions are the only allowlisted child events; everything else through `audit.forged_action`). The `packages/core/src/audit-partition.ts` exhaustiveness-check is required to prevent drift.
- **B.4 migrate is the highest-risk command.** Symlink triple-check + O_NOFOLLOW + snapshot-compare + dotenv parse-don't-line-strip + post-rewrite redaction-verify (parse with the loader's parser, assert zero matches, else E_READBACK_FAIL). The fixture in §F.1 with multi-line quoted value + export-prefixed entry + comments is the canonical test.
- **A.3 generation-persists-first ordering is deliberate.** Crash window between step 10 (generation commit) and step 11 (file rename) leaves user in CORRUPTED state requiring wipe + full re-provision. Documented in §F.4 as a known UX cost; recovery via `wipe + migrate`. Reversed ordering loses to FS-write malware; ±1 tolerance halves rollback resistance — neither is acceptable. Real defense is the `kuzo credentials list --json` backup affordance.

**Open cross-phase note:** `plugin-host.ts` prototype freeze tracked in issue #26. Low priority — process isolation already limits blast radius.

**Gotchas carried forward (still relevant for any plugin-install-adjacent work):**
- Don't try to use `npm token create --bypass-2fa --scopes ...` CLI — npm 11.6.2 rejects those flags as "Unknown cli config" despite the docs. Granular tokens must be created via web UI.
- Registry CDN has ~minutes of replication lag for new packages. `npm view` may 404 on something you just published. Query `https://registry.npmjs.org/<scope>%2F<name>` directly for authoritative state.
- pacote is CJS; from ESM use `import pacote from "pacote"` (default = `module.exports`). `import * as pacote` puts everything under `.default` only and breaks at runtime.
- `pacote.extract(spec, target, opts)` does NOT run install scripts — those happen on `npm install`. Extract to `.tmp/pkg/`, then `npm install --prefix=.tmp --ignore-scripts --no-audit --no-fund` for transitive deps. NEVER call `pacote.extract` or `npm install` on the plugin before `verifyPackageProvenance` succeeds.
- Copilot does NOT auto-re-review on every push to a PR — comment `@copilot review` to explicitly trigger round 2+. Auto-review only fires on PR creation.
- Copilot round-2 response to an `@copilot review` trigger comes back as a PR **issue comment**, not a formal review. The canonical pipeline's `"Pull request overview"` body regex won't count it — read the issue comment thread directly. The round-2 comment is posted as user login `Copilot` (capital C, no `[bot]` suffix), NOT `copilot-pull-request-reviewer[bot]` (which is the round-1 formal-review login). Poll scripts must match both.
- Commander's negated flags (`--no-cache`) populate `options.cache: boolean` (default true, false when flag present), NOT `options.noCache`. Type your `XOptions` interface and check accordingly; otherwise the bypass path is unreachable (caught in D.3 Copilot r1).
- `--allow-registry <url>` is strictly a GATE that permits `--registry <url>` to target a non-npmjs.org URL. It MUST NOT act as a selector on its own. (D.1 latent bug swept in D.3.)
- `require(...)` **fails** in ESM modules even though tooling may not warn loudly. Always top-level `import` from `node:fs` etc.
- When you add a new `AuditAction` variant to `packages/core/src/audit.ts`, the `AuditAction` union is CLOSED — TS will reject any emit with a non-listed string. Pick a verb + past-tense form.
- `stageTarball` must pin pacote calls to the VERIFIED `version + integrity`, not the user-supplied `versionSpec`. Otherwise `latest`/range specs silently open a TOCTOU window between verify and extract.
- Synthetic staging `package.json` must merge `peerDependencies` + `optionalDependencies` into `dependencies`. First-party plugins declare `@kuzo-mcp/types` as peer (locked-decision #10) and `npm install --omit=dev` will silently skip peer deps otherwise.
- Dynamic `import()` of a staged manifest caches by URL. Bust with `?staged=<Date.now()>` so repeat installs/updates/rollbacks in the same process get fresh modules.
- For write commands that read shared state, **acquire the lock BEFORE reading** — reading outside the lock opens TOCTOU windows with concurrent uninstall/update (caught in D.3 Copilot r1 on update.ts, also applies to any future shared-state write path).
- For multi-step writes on shared state (index + symlink), write the atomic metadata first (index.json uses tmp + rename so it's atomic), THEN the non-atomic operation (symlink flip), with a revert-the-metadata path if the non-atomic step fails. Disk/index drift is worse than a clean re-run request.
- `verification.json` shape evolves additively — D.1 entries lack `policySnapshot`, shape guard must treat missing optional fields as "pre-D.3, forced cache miss" rather than rejecting the whole entry.
- **npm Trusted Publishing requires npm ≥ 11.5.1** (per npm's own docs). Pre-TP npm CLI silently 404s on PUT during publish — auth failure shown as not-found, not 401 — because npm falls back to setup-node's placeholder `NODE_AUTH_TOKEN=XXXXX-XXXXX-XXXXX-XXXXX` which the registry rejects. Sigstore provenance signing keeps working on the old npm (that's a `--provenance` feature available since npm 9.5), so the failure looks like a TP-config issue when it's actually a CLI version issue.
- **Do NOT `npm install -g npm@N` to upgrade in place** on a CI runner — it reliably trips `MODULE_NOT_FOUND: 'promise-retry'` mid-install (npm yanks its own internal deps and can't finish). Bump the Node version instead: Node 24.x ships with npm 11.12+ natively. Verify the bundled npm via `https://nodejs.org/download/release/index.json`.
- **changesets/action's "Version PR" flow needs a repo setting flipped on:** **Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"**. Without it, the workflow successfully pushes the `changeset-release/main` branch but fails at PR creation with `HttpError: GitHub Actions is not permitted to create or approve pull requests`. Resolution: flip the setting, then `gh run rerun <id> --failed` re-fires the workflow which opens the PR cleanly.
- **Plugin manifest `version` field MUST derive from `package.json`** via `createRequire(import.meta.url)("../package.json")`. Hardcoding a literal causes drift; `import ... with { type: "json" }` is Node 22+ stable / 20.x experimental-flag (will SyntaxError); `assert { type: "json" }` is deprecated per current ECMAScript spec. createRequire is universal Node 16+, no flags. The install CLI's `E_VERSION_MISMATCH` check (D.3) correctly refuses to install on drift — that's how PR #29's bug surfaced.

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
13. **npm CLI baseline = whatever Node 24 ships natively.** Trusted Publishing requires npm ≥ 11.5.1; in-place `npm install -g npm@N` reliably crashes the runner. `release.yml` uses `node-version: 24` (currently 24.15.0 with npm 11.12.1 bundled). Do NOT re-suggest pinning npm separately — Node version is the lever.
14. **Plugin manifest `version` is derived, never hardcoded.** Each plugin's `index.ts` reads `version: pkgJson.version` via `createRequire(import.meta.url)("../package.json")`. Drift is impossible by construction; the install CLI's `E_VERSION_MISMATCH` check is now a tautological pass for our packages (kept as defense-in-depth for third-party plugins that don't follow this convention).

### Branch state (post-2.5e first release)

- **main** at `65ec0f1` — PR #32 merge commit. Recent significant commits: `6214aa7` (PR #30 — chore(release): version packages — version bump 0.0.1 → 0.0.2 for 5 packages), `6247d62` (PR #29 — manifest version drift fix), `02fcc67` (PR #31 — Claude Code GitHub Workflow), `edc34b1` (PR #28 — Node 24 for TP), `eab157d` (PR #27 — npm 11 for TP).
- **npm registry state:**
  - `0.0.0-bootstrap.0`: all 6 (legacy bootstrap, predates TP)
  - `0.0.1`: types, core, cli, plugin-git-context, plugin-github, plugin-jira (first real release with Sigstore attestations)
  - `0.0.2`: core, cli, plugin-git-context, plugin-github, plugin-jira (manifest drift fix)
  - `latest` dist-tag: 0.0.2 for all 5 bumped, 0.0.1 for types
- All local feature branches from this saga deleted (`fix/npm-11-trusted-publishing`, `fix/node-24-for-trusted-publishing`, `fix/remove-manifest-version`, `changeset-release/main` all cleaned by `--delete-branch` on merge).

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

- **`docs/PLANNING.md` §2.5e:** Fixed in PR #19 — Turborepo → pnpm workspaces, unscoped → `@kuzo-mcp/*`.
- **`docs/SECURITY.md` §5 (supply chain):** review + update at phase close per spec §E.1.

### PR history

- **PR #15** — A.1–A.3: pnpm prereqs + `@kuzo-mcp/types`.
- **PR #17** — A.4–A.7: extract `@kuzo-mcp/{core,plugin-*,cli}` + loader rewrite + legacy src/ cleanup.
- **PR #18** — A.9–A.10: cross-plugin ESLint rule + dev-to-install parity test + hardening timing fix.
- **PR #19** — B.1–B.4: Changesets config + release workflow + publish scripts + `workspace:^` fix + PLANNING.md stale refs.
- **PR #20** — Docs-only: clarify Part C Node-version scope before kicking off Part C.
- **PR #21** — Part C: `@kuzo-mcp/core/provenance` library + smoke script + CI provenance job. 2 Copilot rounds (10/0 comments).
- **PR #22** — Part D.1: `kuzo plugins install` command, state + lock primitives, versioned-layout resolver. 1 Copilot round (8 comments, all fixed in `55fa650`) + r2 LGTM via PR comment.
- **PR #24** — Part D.2: `kuzo plugins {list, uninstall, refresh-trust-root}` commands, `acquireLockOrExit` anti-pattern swept from all three commands, `AuditAction` extended. 1 Copilot round (5 comments, all fixed in `3595a3e`) + r2 LGTM via PR issue comment.
- **PR #25** — Part D.3: `kuzo plugins {update, rollback, verify}` commands + refactor extracting `staging.ts` / `verification-cache.ts` / `summary-card.ts` from install.ts + `policySnapshot` backfill + latent D.1 `--allow-registry`-as-selector fix swept across all three registry-aware commands + TOCTOU lock-before-read fix on update + rollback commit-order + revert-on-symlink-failure. 1 Copilot round (11 comments, all fixed in `2eeadfe`) + r2 LGTM via PR issue comment. Also absorbed a parallel `copilot-swe-agent[bot]` style-fix commit `5379080` via rebase.
- **PR #27** — fix(ci): bump npm to 11 for Trusted Publishing. Surface fix to unblock 10+ failed Release runs on main. 1 Copilot round (1 comment — pinning suggestion, pushed back: floating major is correct for irregular release workflows). Below 5-threshold, merged. Did NOT actually unblock the publish — PR #28 was needed.
- **PR #28** — fix(ci): bump Node to 24 instead of in-place npm upgrade. Pivot after PR #27's `npm install -g npm@11` died on `MODULE_NOT_FOUND: 'promise-retry'`. 1 Copilot round (0 comments, clean). After this merged, `release.yml` published all 6 `@kuzo-mcp/*@0.0.1` cleanly under OIDC TP with Sigstore attestations.
- **PR #29** — fix(plugins): derive manifest version from package.json (0.0.2). Bug uncovered by the 0.0.1 live smoke — `kuzo plugins install git-context@0.0.1` Sigstore-verified end-to-end then died at `E_VERSION_MISMATCH` because all 3 plugin sources hardcoded `version: "1.0.0"`. Fix uses `createRequire(import.meta.url)("../package.json")` (chose over `with`/`assert` for Node 16+ universal compat). 1 Copilot round (4 comments — Node 20 import-attributes compat × 3 + changeset wording. All addressed in `40cd7d8`, replies posted inline). Below 5-threshold, merged.
- **PR #30** — chore(release): version packages. Auto-generated by changesets/action after PR #29's changeset landed. Bumped 5 packages to `0.0.2` (types stayed `0.0.1` — upstream of plugins, no cascade triggered). First run failed at PR creation due to repo "Allow Actions to create PRs" setting being off; resolved by flipping the setting + `gh run rerun --failed`. After merge, `release.yml` published 5 packages at `0.0.2`.
- **PR #31, #32** — Sean's parallel work: `Add Claude Code GitHub Workflow` and `feat(ci): add Claude multi-tier auto-review system`. Not part of the release-fix chain; landed in the same window.
- **PR #43** — Phase 2.6 Theme 0 (build-order step 0): bake `kuzoPlugin.capabilities` into all 3 plugin `package.json` files + add `scripts/check-plugin-manifest-parity.mjs`. 2 auto-review rounds. Round-1 fix-then-ship: Correctness flagged that per-package `postbuild` never fires from root `tsc -b` / CI / release path — drift could land + publish unnoticed. Fix `93abc82` added root `check:manifest` script chained into `pnpm build`; per-package `postbuild` kept as belt-and-suspenders for `pnpm --filter ... build` (spec §A.0.1 acceptance). Round-2 ship/0/0 across all 3 lanes. Judge merge HIGH. Synthesizer's round-1 "auto-escalated to deep review" claim was a hallucination — `claude-deep-review` label never actually applied, no Tier 3 ran. Carried-forward gotcha: round-2+ auto-review is **manual workflow_dispatch** on this project (no synchronize trigger).
- **PR #45** — Phase 2.6 Theme 1 (`KUZO_HOME` env override + shared `packages/core/src/paths.ts`, spec §E.1–E.2). 3 auto-review rounds, all ship across all 3 specialists every round (verdict trend: 0/3 → 0/4 → 0/3 advisories). Round-1 fixes (`87b1b08`): empty-string env-rejection + `,`/`\n` comma-injection rejection in env overrides + restored trailing slash on `--allow-fs-read=` (spec direction to drop it was incorrect — Node 22 distinguishes `/dir/` recursive from `/dir` inode-only) + widened ESLint selector to 3 forms. Round-2 fixes (`528f8e6`): namespace-import `os.homedir()` coverage in ESLint via `:matches()` (covers 6 drift shapes total) + `assertNoFsArgInjection()` hoisted as public helper from paths.ts, applied to `pluginFsPath` arm of sandbox-arg too. Round-2 advisory **pushed back inline:** the 4 file-path helpers (`credentialsFilePath`, `consentFilePath`, `auditFilePath`, `kuzoHomeLockPath`) are pre-positioned per spec §E.2 contract — pre-emptive for Theme 2/6/8 consumers. Round-3 advisories tracked as **issue #46** for Theme 2 sweep (judge merge HIGH): assert `kuzoHome()` fallback branch (`homedir()`) against fs-arg injection (defense-in-depth — L161 plugin-process comment currently overclaims "kuzoHome() self-validates"), drop dead CLI `kuzoHome` re-export, JSDoc drift sweep on audit/consent/verify path helpers. Impartial judge sub-agent (fresh `general-purpose`, no review history) confirmed merge per "round 4 should be reserved for genuine concerns, not advisory chasing." All 7 R26 inventory sites refactored; `git grep` for `homedir().*\.kuzo` returns zero matches outside `packages/core/src/paths.ts`.
- **PR #47** — Phase 2.6 Theme 2 (storage primitives, spec §A.1–A.5: `cipher.ts` + `errors.ts` + `key-provider.ts` + `testing.ts` + `store.ts`). 2 auto-review rounds. Round-1 verdict synthesis surfaced 0/2 advisory but Correctness lane posted 1 BLOCKING inline (test files excluded from typecheck via tsconfig.json regression) WITHOUT a JSON sentinel — silent under-counting. True round-1 was 1 blocking + 2 advisory. Fixed in `da6357a`: (a) reverted tsconfig.json `exclude` + moved tarball filtering to `packages/core/package.json#files` negation patterns (`.npmignore` is silently ignored when `files` is present per npm spec); (b) relocated `InMemoryKeyProvider` to a new `./credentials/testing.ts` published via the `@kuzo-mcp/core/credentials/testing` subpath off the main barrel (public-surface separation is the primary defense once Theme 4 wires `chooseKeyProvider()`); (c) Architecture's mode-method-coupling advisory **pushed back as won't-fix** (YAGNI for closed 4-provider set per spec §A.5; not re-raised in round 2). Round-2: all 3 specialists ship; single cosmetic JSDoc advisory on `generationFilePath` softened in `e836d6e`. Issue #46 (Theme 1 round-3 carryover) sweep landed as the first commit on the same branch (`8bd9d7b`). Tier 3 deep review hit bot-allowlist infra failure → tracked as **issue #48** along with the round-1 silent under-counting observation. Judge merge HIGH confidence after round 2. 58 new node:test cases via `tsx`. `AuditAction` extended with 3 lifecycle variants only — write-side variants deferred to Theme 5/6 per §0 build order.
- **PR #49** — Phase 2.6 Theme 3 (`CredentialSource` + env-override collection, spec §A.6–A.7). **1 round, clean ship across all 3 Tier 2 specialists (0 blocking, 0 advisory, 0 inline comments).** Judge merge HIGH. Pure-logic theme — no I/O, no boot wiring. `packages/core/src/credentials/source.ts` (`CredentialSource` class with env-override-wins-over-store merge + `extractForPlugin({required, optional})` drop-in for `ConfigManager.extractPluginConfig`); `packages/core/src/credentials/env-overrides.ts` (`collectEnvOverrides` dual-pattern with namespaced-wins + `scrubProcessEnv` with `ALWAYS_SCRUB`). Round-4 fixes all in source: B4 (no schema change), A2 (`KUZO_NO_ENV_SCRUB` in `ALWAYS_SCRUB` so plugin children can't observe kill-switch state), N1 (prefix-delete sweep skips ALWAYS_SCRUB), B11 (`auditLogger` threaded as fn-arg, not constructor), B8 (`isCredentialCapability` added to `@kuzo-mcp/types` mirroring `isV2Plugin`). `AuditAction` extended with `credential.scrub_disabled` only. 39 new node:test cases (97 total credential tests). Tier 3 auto-escalated on large-diff (>500 lines) — label actually applied this time (vs PR #43's hallucinated escalation) but all 4 deep specialists + Deep synthesizer failed via **issue #48 bot-allowlist** ("Workflow initiated by non-human actor: claude (type: Bot)") — physical workflow failure, NOT a Tier 3 verdict. Security-lane tripwire recorded inline for Theme 4 reviewer: `collectEnvOverrides` is permissive on unknown `KUZO_TOKEN_*` names; Theme 4 boot must NOT call it against an unsanitized `declaredEnvNames` (Theme 7's §A.12 reservation gate is the production defense).
- **PR #50** — Phase 2.6 Theme 4 (boot sequence + scrub + key-provider selection, spec §C.1–C.3 + §C.7 + §C.9 + round-4 B2). **4 rounds, judge merge HIGH at the hard cap. SHIP every round** (verdict trend: 0/7 → 0/3 → 0/4 → 0/3). New `packages/core/src/server.ts` exports `async runServer(options?)` with the pinned §C.1 step order; self-invocation guard at file bottom keeps `import { runServer }` from auto-booting. New `packages/core/src/key-provider-choice.ts` (§A.5 4-rule precedence). New `packages/core/src/manifest-env-names.ts` reads STATIC `package.json#kuzoPlugin.capabilities` via `fs.readFileSync` only (invariant 6 — no plugin entry `import()` pre-scrub); applies `RESERVED_KUZO_ENV` runtime denylist (10 kuzo-internal env names — defense-in-depth; Theme 7 §A.12 install-time gate is canonical). `packages/core/src/plugin-resolver.ts` adds `resolvePluginPackageDir`. Loader takes `CredentialSource` as 6th constructor arg; call-site swap via `isCredentialCapability` filter. `ConfigManager.extractPluginConfig` deleted (§C.7). ESLint `child_process` ban widened to `packages/core/src/**/*.ts` minus `plugin-process.ts` + `paths.ts`; `allowTypeImports: true` lets `ipc.ts` keep `import type { ChildProcess }`. **Round-1 SEC catch is the load-bearing fix:** narrowed `scrubProcessEnv` keys from `[...declaredEnvNames, ...Object.keys(envOverrides)]` to `[...declaredEnvNames]` — closed the `KUZO_TOKEN_PATH=evil` → `delete process.env.PATH` attack. Fix commits: `fd8f998` (R1 — 7 advisories), `ca09f4b` (R2 — JSON.parse null defense), `e6bde7f` (R3 — RESERVED_KUZO_ENV + widened ESLint scope), `4d7bd9a` (R4 — trust-env names added). Pushbacks documented in PR comments: changeset cadence (pre-1.0 batches at phase close), `node:` prefix convention (new files match dominant 32 vs 14), ESLint dynamic-import gap (Theme 7 boundary), plugin-name path-traversal (Theme 7 install CLI). Tier 3 hit issue #48 bot-allowlist again on all 4 deep specialists. **Round-4 verdict synthesizer crashed** on `actions/checkout@v4` git auth ("could not read Username for 'https://github.com'") — separate CI infra glitch on the synth job only; all 3 specialists posted JSON sentinels successfully. New gotcha if it recurs in Theme 5+: file as a tracking issue. Impartial judge sub-agent (fresh `general-purpose`, no review history) ruled merge with HIGH confidence after round 4 — all 3 specialists shipped, pushbacks defensible per the Security specialist's own "All findings are defense-in-depth or hardening suggestions, no blockers" rationale.
- **PR #51** — Phase 2.6 Theme 5 (audit IPC routing + rate-limit + log rotation, spec §C.10 + §C.10.1). **4 rounds, impartial judge merge HIGH at the hard cap.** Verdict trend: SHIP 0/5 → SHIP 0/7 (5 unique) → SHIP 0/6 → **fix-then-ship 1/5** — first 3 rounds shipped with zero blocking, round-4 raised one BLOCKING Security finding that was fixed cleanly. **Code surface:** `audit.ts` split (`AuditLogger` interface + `FileBackedAuditLogger` concrete + rotation at 50 MiB / 5 retained / atomic rename + `query()` globs rotated files + `mkdirSync` 0o700 + `appendFileSync` 0o600 + `safeStringify` never-throw envelope + `node:fs`/`node:path` prefix). New `audit-partition.ts` — `Record<AuditAction, "parent-only" | "child-permitted">` exhaustiveness check forces every new variant to be classified at compile time. New `audit-ipc.ts` — `TokenBucket` (wall-clock, 200 burst / 100 refill-per-sec, injectable clock) + `decideAudit` (constructs stamped event from explicit named fields, no spread of untrusted wire — round-4 BLOCKING fix) + `isAuditWireEvent` (closed-enum `outcome` + array `details` rejection) + `withinAuditByteCap` (`Buffer.byteLength` against 16 KiB cap). `plugin-host.ts` rewritten with `IpcAuditLogger` proxy + try-wrapped `channel.notify`. `plugin-process.ts` extended with rate-limit BEFORE wire validation (so malformed/oversize/forged all count) + `handleAuditEvent` gauntlet + trailing-flush timer + cleanup drain. `server.ts` emits one-time `audit.partition_initialized` at boot. ESLint `plugin-host{*,/**/*}.ts` block bans `appendFile*` from `node:fs` + `fs/promises` + namespace-import bypass selector + `FileBackedAuditLogger` named import. 4 new `AuditAction` variants. Fix commits: `d23d62d` (R1 — 4 fixes + 1 defer → issue #52), `f7702c6` (R2 — 5 fixes incl. UTF-8 byte length + outcome union exhaustiveness + mkdir 0o700), `f8a2014` (R3 — 6 fixes: rate-limit-before-wire-validation refactor + stderr never-throw + cleanup), `4c6caa4` (R4 — 1 BLOCKING fix + 3 advisories + 2 defensible pushbacks). **Round-4 BLOCKING fix (the headline):** child-supplied `timestamp` could override the parent's authoritative one via spread order in `FileBackedAuditLogger.log` + `decideAudit`'s `{...event}` spread of untrusted wire. Fix layers two defenses: explicit-field construction in `decideAudit` (no spread) + `{...event, timestamp: ...}` ordering in `FileBackedAuditLogger.log` (parent stamp wins regardless of caller). 3 new tests lock the invariants (no timestamp leak, no pid smuggling when childPid undefined, exact-field-count). **Pushbacks (all defensible):** changeset cadence (phase-close batching per project memory), forgery-flood retention erosion → issue #52 (spec §C.10 mandates per-attempt emission), relative-import bypass via hypothetical plugin-host/ subdir (forward-compat — `files:` glob already widened, switch `paths:` → `patterns:` only when subdir actually exists). 47 `node:test` cases in `pnpm test:audit` (new script chained into root `pnpm test`); 97 credentials tests still pass; parity test green end-to-end with `audit.partition_initialized` confirmed firing at boot before any other audit event. Round-3 synth crashed on its 30-turn cap (new gotcha distinct from Theme 4's checkout-auth glitch); all 3 specialists posted clean JSON sentinels and the fix landed without a synthesized sticky. Tier 3 deep review didn't auto-escalate on the >500-line threshold — synth's logic saw the round-4 post-fix state as ship-ready. Impartial judge (fresh `general-purpose`) ruled merge with HIGH confidence: "BLOCKING fix is structurally airtight: stamped event is built field-by-field from named wire fields … smuggling closed by construction, not by check-then-trust".

- **PR #53** — Phase 2.6 Theme 6 (broker write-side audit slots + shutdown hooks + retire `clientFactories` singleton, spec §C.4 + §C.5 + round-4 advisory A1). **4 rounds, impartial judge merge HIGH at the hard cap.** Verdict trend: SHIP 0/2 → SHIP 0/5 → SHIP 0/1 → SHIP 0/2 — every round shipped with zero blocking across all 3 specialists. Fix commits: `f6f7e5b` (R1 — construction-time guard against malicious first-party override via the `clientFactories` test-seam, with new test independently locking both `"github"` and `"jira"` reservation paths), `a1cd799` (R2 — sticky `hasEmittedClose` for idempotent `credential.store_locked` emission + try/finally around `plugin.shutdown()` so broker scrub runs on rejection + dropped redundant `as AuditEvent` cast in test helper), `2185581` (R3 — clarified third-party factory manifest-contract delegation in JSDoc on `CredentialBroker.registerClientFactory` + inline comment in `getClient`; spec §C.4 mandates the delegation, R4 Security explicitly endorsed), `dd63ad7` (R4 — dropped redundant `factory as ClientFactory` cast via return-type covariance + documented lock-once-per-instance lifecycle contract on the `hasEmittedClose` JSDoc per Sec reviewer's option (b)). **Verdict synthesizer crashed in BOTH R3 and R4** — same gotcha class as Theme 4 R4 + Theme 5 R3 (the synth job is a recurring CI fragility tracked alongside issue #48; specialist jobs themselves complete cleanly). All 3 specialist JSON sentinels carried the signal across R3/R4; the impartial judge was fed those plus the round-by-round fix log instead of a synthesized sticky. **Code surface:** 7 new write-side `AuditAction` variants (`credential.set/.deleted/.rotated/.migrated/.migration_partial/.wiped/.tested`) classified parent-only in `AUDIT_ACTION_PARTITION` — slot reservation only, Theme 7/8 wire the producers. `credentials.ts` rewrite: `clientFactories` Map retired from module scope to instance state pre-loaded from module-level `FIRST_PARTY_FACTORIES` constant; new `registerClientFactory<T>(service, factory)` method on `CredentialBroker` (in `@kuzo-mcp/types`) lets third-party plugins extend their own broker. First-party names (`"github"` / `"jira"`) write-locked at BOTH the runtime register gate AND the construction-time `clientFactories` test-seam (R1 Sec A1) — both gates root in the immutable `FIRST_PARTY_FACTORIES` key set, not the per-instance map. Idempotent no-op on re-register. Third-party factories deliberately skip the first-party `access:"client"` manifest-contract check per spec §C.4 (loader scopes config by env-name not access mode — self-contained, no cross-trust escalation; consent UI is the user-facing line of defense). New `DefaultCredentialBroker.shutdown()` clears config + clientFactories + clientCache; wired into `plugin-host.handleShutdown` AFTER `plugin.shutdown()` and BEFORE `process.exit` inside a try/finally so the scrub fires even on plugin shutdown rejection (R2 Sec/Corr advisory) — the throw still propagates so the parent observes the failed plugin shutdown. `EncryptedCredentialStore.close()` audit reshape per spec §C.5: unconditional emit with `priorCount` + `backend` in details (never-unlocked close now emits `priorCount=0` — forensic "stopped without ever unlocking" correlation); sticky `hasEmittedClose` flag prevents double-emit on signal-handler + idempotent teardown patterns; `wipeKeyCache?.()` still runs on every close so malformed teardown can never leave the master key Buffer populated. New `packages/core/src/credentials.test.ts` (14 broker tests) + 2 new store double-close tests in `store.test.ts`. 113 credentials tests pass via `pnpm test:credentials` (97 prior + 14 broker + 2 close-idempotency). **Pushbacks:** R2 Architecture "static `forTesting()` factory" refactor → won't-fix: R1 construction-time guard already structurally enforces the reservation invariant; refactor would change access surface without changing security posture and would break third-party `registerClientFactory` test pattern that legitimately needs an isolated factory map. Tier 3 deep-review auto-escalated on the R2 541-line threshold; same issue #48 bot-allowlist failure as every prior Theme PR. Impartial judge (fresh `general-purpose`, no review history) ruled merge HIGH: "Both R4 advisories were genuinely addressed in dd63ad7. The cast removal is a real micro-improvement … The JSDoc documentation of the lock-once contract is one of the two valid options the reviewer themselves offered. The 4-round trend converges on cosmetics. Pushbacks held up under further review. Diff matches stated scope."

PR granularity is implementer's call based on current context, review appetite, and whether the work has naturally separable seams.

### Do NOT

- Skip the parity test (`pnpm test:parity`) before any PR that touches `packages/*/package.json` or loader code — it's the only thing that catches silent dual-mode resolution breakage.
- Rewrite `SECURITY.md` in isolation — that update lands at phase close (§E.1). (`PLANNING.md` stale refs already fixed in PR #19.)
- Re-suggest `tsc -b --noEmit` for `typecheck` — blocked by TS6310 with composite projects; already evaluated in A.3.
- Open cross-session debate on spec §E.2 questions unless you actually hit them — use recommended defaults.
- Skip the parity test (§A.8) — it's the only gate that catches silent dual-mode resolution breakage. Non-negotiable per spec §A.9.
- Remove `@kuzo-mcp/types` from plugin `devDependencies` thinking the peer entry is enough — see locked decision #10. This will silently break local workspace builds.
- Change `start:mcp` back to `pnpm --filter @kuzo-mcp/core exec node dist/server.js` — see locked decision #12. Breaks dotenv cwd fallback.
- Extract plugin clients into `@kuzo-mcp/clients-*` packages ("Option C") as part of 2.5e. Intentionally deferred — it is proper decoupling but not phase-blocking. Subpath exports are the 2.5e-era answer.
- Claim `.kuzo/workflows/` or `~/.kuzo/workflows/` for any 2.5e work. Those directory names are reserved for the Phase 3 user-definable workflows feature (tool-surface filtering + macros) — see the GitHub issue for the full design discussion. Install CLI, consent files, plugin state — none of those should live under `workflows/`.

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
