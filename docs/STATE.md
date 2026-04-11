# Session State

> Current state of the project. Updated each session.

**Last Updated:** 2026-04-10

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
- **2.b** — github plugin (NEXT UP)
- **2.c** — jira plugin (new MCP exposure of Jira methods)
- **2.d** — cleanup + CLI migration (delete legacy `src/services/`, `src/mcp/server.ts`, `src/types/index.ts`; point CLI at plugin registry)

Old code stays alive until 2.d so nothing breaks mid-flight. `src/core/server.ts` and `src/mcp/server.ts` coexist as separate entry points during the migration.

**Phase 2.a — git-context plugin** (complete — merged PR #6)
- `src/plugins/git-context/` with index, git detection, types, tool, and resource
- 1 tool (`get_git_context`) and 1 resource (`git://context`) exposed
- Cross-platform `findGitRoot` (Windows drive roots now terminate correctly)
- `_`-prefix convention respected by eslint (matches TS `noUnusedParameters`)

**Next up: Phase 2.b — github plugin**

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

## What Exists Today

### Working (pre-refactor)
- Monolithic MCP server with 6 PR tools (`src/mcp/server.ts`)
- GitHub service with full Octokit wrapper (`src/services/github.ts`)
- Jira service with REST v3 integration (`src/services/jira.ts`)
- Git context detection (`src/services/git.ts`)
- Interactive CLI with PR, repo, review, jira commands (`src/cli/`)
- Bash CLI alternative (`cli-bash/`)
- Webhook server for GitHub push events (`src/server.ts`)

### New (Phase 1)
- Plugin system core (`src/core/` — server, registry, loader, config, logger)
- Plugin type definitions (`src/plugins/types.ts`)

### Not Yet Built
- Actual plugins (git-context, github, jira — Phase 2)
- Jira MCP tools (service exists, not exposed via MCP)
- Any Phase 3+ integrations (releases, actions, labels, etc.)
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
