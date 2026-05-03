# Kuzo MCP — Project Instructions

> Plugin-based personal MCP server — GitHub, Jira, and beyond.

---

## Project Overview

Kuzo MCP is a **plugin-based MCP server** where each integration (GitHub, Jira, Calendar, SMS, etc.) is a self-contained plugin. The core handles MCP protocol, plugin lifecycle, config, and logging. Plugins register tools, resources, and optionally CLI commands.

**Key docs:**
- `docs/PLANNING.md` — Architecture spec and migration roadmap (note: §2.5e has stale Turborepo/unscoped-naming refs — `docs/2.5e-spec.md` supersedes)
- `docs/STATE.md` — Current phase, session state, and fresh-session handoff block
- `docs/SECURITY.md` — Phase 2.5 security model, threat model, implementation plan
- `docs/2.5e-spec.md` — **Active spec.** Phase 2.5e implementation north star (monorepo + provenance + install CLI)

**Current phase:** 2.5e code + bookkeeping complete (PR #25 `a316c9d`, SECURITY.md §8 rewritten, issue #26 filed, pre-release secret scan clean; 2026-04-21). Only the first real npm release remains — `@kuzo-mcp/types@0.0.1` canary to validate Trusted Publishing + Sigstore provenance, then batch the other 5 packages. On a fresh session, if user says "next", read `docs/STATE.md` → "Fresh-session handoff" section (it's a step-by-step release runbook).

---

## Tech Stack

| Category | Choice |
|----------|--------|
| Language | TypeScript 5.5+ (strict mode) |
| Runtime | Node.js 20+ |
| Modules | ESM (`"type": "module"`) |
| MCP SDK | `@modelcontextprotocol/sdk` |
| Validation | Zod (all tool inputs) |
| GitHub API | `@octokit/rest` |
| Jira API | Native fetch (Atlassian Cloud REST v3) |
| CLI | Commander + Inquirer |
| Build | tsc to `dist/` |

---

## Architecture

### Plugin System

Every integration implements `KuzoPlugin` (defined in `src/plugins/types.ts`):

```
src/
├── core/           # MCP server, plugin registry, loader, config, logger
├── plugins/
│   ├── types.ts    # KuzoPlugin, PluginContext, ToolDefinition, ResourceDefinition
│   ├── git-context/
│   ├── github/
│   ├── jira/
│   └── ...
└── cli/            # Interactive CLI (uses plugin registry)
```

### Rules

- Plugins NEVER import from other plugins — use `callTool()` via `PluginContext`
- Each plugin owns its types, client, and tool definitions
- The core knows nothing about specific integrations
- Missing config = plugin skipped with warning, not crash
- No singletons — everything flows through `PluginContext`

### Config

- **Secrets** go in `.env` (GITHUB_TOKEN, JIRA_API_TOKEN, etc.)
- **Plugin enable/disable** goes in `kuzo.config.ts`
- Each plugin declares `requiredConfig` and `optionalConfig` — the loader validates before initializing

---

## Code Conventions

### TypeScript

- **Strict mode** — no `any`, use `unknown` and narrow
- **Type-only imports** — `import type { Foo }` when only used as a type
- **ESM imports** — always use `.js` extensions in import paths
- **No singletons** — everything through `PluginContext`
- **Zod schemas** for all MCP tool inputs, with descriptions on every field

### MCP Tool Design

Every tool must:
1. Have a clear, LLM-readable description with usage tips
2. Validate inputs with Zod (descriptions on every field)
3. Return actionable error messages (Claude reads these)
4. Auto-detect context where possible (repo, branch, etc.)

### File Organization

- Plugin types: `src/plugins/{name}/types.ts` (NOT a shared types file)
- Tool groups: `src/plugins/{name}/tools/pulls.ts`, `issues.ts`, etc.
- Plugin entry: `src/plugins/{name}/index.ts` implements `KuzoPlugin`
- API client: `src/plugins/{name}/client.ts` wraps the external API

### Git

**Branch pattern:** `phase-N/description` or `fix/description`

**Commit format:**
```
type(scope): description
```

**Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`
**Scopes:** `core`, `plugins`, `github`, `jira`, `git`, `cli`, `config`

---

## Quality Gates

Before every commit:

```bash
npm run typecheck && npm run lint && npm run build
```

---

## Anti-Patterns

- **No god files** — the 920-line monolithic server.ts is what we're fixing
- **No singletons** — `getGitHubService()` pattern is dead
- **No cross-plugin imports** — `callTool()` only
- **No flat type files** — each plugin owns its types
- **No inline handlers** — tools live in `plugins/{name}/tools/`
- **No silent config failures** — always log what loaded and what didn't
- **No over-engineering** — no DI frameworks, no hot-reload, no plugin versioning until we actually need them

---

## Reviewing with @claude

Three review tiers powered by the Claude GitHub App. **The action loads THIS file at runtime** — everything below is standing instructions for both the human and the reviewer.

### Review tiers

| Tier | Trigger | Model | Effort | Use for |
|------|---------|-------|--------|---------|
| **1: `@claude` Q&A** | mention in issue / PR / review comment | Opus 4.6 | `max` | targeted questions, one-off code reads, CI-failure inspection |
| **2: Auto-review** | every non-draft PR (open / sync / ready) | Opus 4.7 | `xhigh` | canonical multi-specialist review |
| **3: Deep review** | label `claude-deep-review` (manual or auto-escalated) | Opus 4.7 | `max`, 30 turns | security-sensitive, large, or escalated changes |

Workflows: `.github/workflows/claude.yml` (Tier 1), `claude-code-review.yml` (Tier 2), `claude-deep-review.yml` (Tier 3). Tier 2 runs three specialists in parallel (🔒 Security / 🏗️ Architecture / ✅ Correctness) plus a verdict synthesizer. Tier 3 adds a 🎯 Threat Model specialist.

All tiers are **READ-ONLY** — `Edit`, `Write`, and `NotebookEdit` are explicitly disallowed. No tier can modify code, push commits, or merge.

### Standing review priorities (in order)

1. **SECURITY** — supply chain (npm publish, OIDC, Trusted Publishing, Sigstore provenance), secret leakage, prompt injection, install CLI safety, auth / token handling, GitHub Actions safety
2. **PLUGIN CONTRACT** — `KuzoPlugin` shape adherence, NO cross-plugin imports (must use `callTool()` via `PluginContext`), Zod coverage with `.describe()` on every field, monorepo boundaries (deps + exports), file organization (per-plugin types / tools / client)
3. **CORRECTNESS** — strict TS (no `any`, use `unknown`+narrow), ESM `.js` import suffixes, async/await hygiene, `??` not `||`, Claude-readable error messages
4. **CONVENTIONS** — see "Anti-Patterns" above

### Path-aware focus

| Path | Primary specialist focus |
|------|--------------------------|
| `packages/core/src/loader/`, `packages/core/src/registry/` | Plugin contract + security (untrusted-plugin loading boundary) |
| `packages/core/src/install/`, `packages/cli/src/install*` | Install CLI safety (path traversal, signature verification, tarball extraction) |
| `packages/plugin-*/` | Plugin contract + Zod coverage + per-plugin API client |
| `packages/types/src/` | Contract changes — flag breaking changes explicitly |
| `docs/SECURITY.md` | Cross-check against threat model + §8 shipped state |
| `.github/workflows/release.yml` | OIDC / Trusted Publishing / Sigstore safety |
| `.changeset/*.md` | Release scope + version bump correctness |

### What NOT to flag

- **Defensive code for impossible cases** — trust framework / type-system guarantees. Validate only at system boundaries (user input, external APIs).
- **Test coverage gaps** — vitest is not wired in CI yet; don't ask for tests until it lands.
- **Architecture re-litigation** — plugin design is locked in `docs/PLANNING.md`. Don't propose alternatives.
- **Premature abstraction** — three similar lines is BETTER than a bad abstraction. Don't suggest DRY without strong evidence.
- **Scope creep** — review the PR's stated scope, not adjacent work or future features.
- **Style nits** — Prettier handles formatting; ignore.
- **Comment density** — code without comments is fine if names are clear; only flag missing comments when WHY is non-obvious.

### Mention syntax cheatsheet

```text
# Targeted question
@claude does this introduce any prompt-injection vectors via the github plugin tools?

# Re-review after fixes
@claude addressed in <sha> — re-review the security findings only

# Inspect CI
@claude check why CI is failing on this PR and surface the root cause

# Explain
@claude walk me through how the install CLI verifies Sigstore attestations here

# Trigger deep review
# Add the `claude-deep-review` label, or run claude-deep-review.yml via workflow_dispatch
```

### Round protocol

Round 1 = the auto-review on PR open / push. Subsequent rounds fire on each new commit (the `synchronize` event re-runs Tier 2). The verdict synthesizer posts a sticky comment (`<!-- KUZO-VERDICT-STICKY -->`) that is updated in place each round.

- **Hard cap: 4 rounds.** After round 4 the synthesizer escalates to a human decision regardless of remaining issues.
- **Auto-escalation to Tier 3** when the synthesizer detects: any specialist verdict = `rethink`, OR `sensitive_paths_touched: true` AND blocking>0, OR total blocking > 5, OR PR diff > 500 lines.
- **CI must be green** before merge unless the PR is explicitly labeled `expected-ci-fail` (early-phase work).

### Reviewer JSON sentinel format

Each specialist embeds a sentinel in its summary comment for the synthesizer to parse:

```html
<!-- KUZO-REVIEW-JSON-{SECURITY|ARCHITECTURE|CORRECTNESS|THREATMODEL}
{"verdict":"ship|fix-then-ship|rethink","blocking_count":N,"advisory_count":N,"sensitive_paths_touched":bool,"top_issues":[...],"rationale":"..."}
-->
```

Don't edit these by hand — they're regenerated each round.
