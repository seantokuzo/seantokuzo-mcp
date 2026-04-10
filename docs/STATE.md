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

**Phase 1: Core Infrastructure** (complete)

- Plugin system types (`src/plugins/types.ts`)
- Structured logger with stderr output for MCP compatibility (`src/core/logger.ts`)
- Config manager with dotenv + per-plugin extraction (`src/core/config.ts`)
- Plugin registry with tool/resource indexing + cross-plugin callTool (`src/core/registry.ts`)
- Plugin loader with discovery, config validation, graceful skip (`src/core/loader.ts`)
- New MCP server delegating through registry (`src/core/server.ts`)
- Zod-to-JSON-Schema conversion for MCP tool listings
- Entry point: `npm run start:kuzo` / `node dist/core/server.js`

**Next up: Phase 2 — Convert Existing Code to Plugins**

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
