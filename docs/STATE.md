# Session State

> Current state of the project. Updated each session.

**Last Updated:** 2026-04-11

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

**Next up: Phase 2.5 — Plugin Security & Open-Source Readiness** (with Phase 2.b deferred `ToolDefinition<TInput>` generic rolled in as warmup)

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

### Core (Phase 1)
- Plugin system core (`src/core/` — server, registry, loader, config, logger)
- Plugin type definitions (`src/plugins/types.ts`)

### Plugins (Phase 2)
- `src/plugins/git-context/` — 1 tool, 1 resource (Phase 2.a, merged PR #6)
- `src/plugins/github/` — 23 tools across pulls/reviews/repos/branches (Phase 2.b, merged PR #7). Cross-plugin `callTool("get_git_context")` consumer.
- `src/plugins/jira/` — 11 tools across tickets/transitions/subtasks/comments (Phase 2.c, merged PR #8). `JiraClient` wraps native `fetch` with Basic auth.

### CLI (Phase 2.d)
- Interactive CLI with PR, repo, review, jira, config commands (`src/cli/`)
- Uses plugin clients directly (`GitHubClient`, `JiraClient`) — no legacy service singletons
- `src/cli/bootstrap.ts` loads `.env` as ESM side-effect before any command module
- Bash CLI alternative still at `cli-bash/` (untouched)

### Legacy Code — Fully Deleted (Phase 2.d, PR #9)
All legacy code paths removed. No monolithic services, no flat type barrel, no webhook server, no legacy MCP entry. Directories `src/services/`, `src/mcp/`, `src/types/`, `src/utils/` no longer exist.

### Not Yet Built
- Plugin security & open-source readiness (Phase 2.5 — NEXT UP)
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

---

## Deferred Items

- Tool name prefixing strategy (prefix with plugin name or keep flat?)
- Testing strategy (vitest setup, mock vs real API)
- Plugin packaging (in-repo only for now, npm packages later if needed)
- Event bus for cross-plugin pub/sub (Phase 5)
