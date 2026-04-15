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

**Current phase:** 2.5e Steps A.1–A.7 complete. A.1–A.3 merged (PR #15); A.4–A.7 in review (PR #17 — extract `@kuzo-mcp/{core,plugin-*,cli}` + loader rewrite). Next: Steps A.9–A.10 (CI no-cross-plugin lint rule + dev-to-install parity test), then Parts B → C → D per `docs/2.5e-spec.md` §0 Build Order. On a fresh session, if user says "next", read `docs/STATE.md` → "Fresh-session handoff" section. **The handoff gates on PR #17 being merged** — if it's still open, confirm with the user before branching.

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
