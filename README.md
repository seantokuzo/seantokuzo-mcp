# 🔥 Kuzo MCP

> A plugin-based Model Context Protocol server — one server, every integration, properly sandboxed.

Kuzo MCP is a **personal MCP platform** built on top of a plugin architecture. Instead of running a separate MCP server for every service you touch (GitHub, Jira, Calendar, SMS, Apple TV, whatever), you run one Kuzo server and load capability-scoped plugins into it.

Under the hood: process-isolated plugins, capability-based permissions, a credential broker that hands out pre-authenticated clients (plugins never see raw tokens), a structured audit log, and a consent flow so you always know what each plugin is allowed to do.

```
                    ┌─────────────────────────────┐
   Claude   ◀──────▶│      @kuzo-mcp/core         │
   (stdio)          │   registry · loader · IPC   │
                    └──┬────────────┬─────────────┘
                       │            │
              fork()   │            │   fork()
                       ▼            ▼
            ┌──────────────────┐  ┌──────────────────┐
            │ @kuzo-mcp/       │  │ @kuzo-mcp/       │
            │  plugin-github   │  │  plugin-jira     │
            │  (child process) │  │  (child process) │
            └──────────────────┘  └──────────────────┘
```

---

## ✨ What ships today

**Core platform**

- 🧩 **Plugin system** — every integration is a self-contained plugin with its own tools, resources, capabilities, and lifecycle.
- 🛡️ **Process isolation** — each plugin runs in its own Node child process, crash-recovered with exponential backoff, heartbeat-monitored, memory-capped.
- 🔑 **Capability-based permissions** — plugins declare exactly what they need (credentials, network domains, filesystem paths, cross-plugin calls, OS exec). The loader enforces it.
- 🪪 **Credential broker** — plugins get pre-authenticated clients or URL-scoped fetch wrappers. Raw token access is an audited escape hatch.
- ✅ **Consent flow** — stored per-plugin in `~/.kuzo/consent.json` with stale-detection on version or capability changes. Interactive review via `kuzo consent`.
- 📋 **Structured audit log** — JSON-lines audit trail at `~/.kuzo/audit.log` covers plugin lifecycle, credential access, and consent decisions. Queryable via `kuzo audit`.

**First-party plugins** (35 tools total)

| Plugin | Tools | What it does |
|---|---|---|
| 🐙 **github** | 23 | Pull requests, reviews, repositories, branches, file content. Auto-detects repo + branch via cross-plugin calls to git-context. |
| 🎫 **jira** | 11 | Tickets, workflow transitions, subtasks, comments (Atlassian REST v3). |
| 📍 **git-context** | 1 | Detects local repo / branch / working tree state. Bridges the others — GitHub PR ops auto-resolve from `cwd`. |

**Companion CLI** — `@kuzo-mcp/cli`

Still here, still vibes. Interactive PR authoring + code review + Jira flows, plus security commands (`kuzo consent`, `kuzo permissions`, `kuzo audit`). Three personalities if you're into that: `chaotic`, `professional`, `zen`. There's also a pure-bash twin in [`cli-bash/`](./cli-bash) for environments without Node.

---

## 🚀 Quick start

Kuzo is a pnpm workspace. Node.js 20+ and pnpm 10+ required.

```bash
# Install + build
pnpm install
pnpm build

# Configure (pick the plugins you want to use)
cp .env.example .env
# edit .env — GITHUB_TOKEN, JIRA_HOST/EMAIL/API_TOKEN, etc.

# Boot the MCP server (stdio)
pnpm start:mcp

# OR use the CLI directly
pnpm cli
```

First run, you'll need to grant consent for each plugin:

```bash
pnpm cli consent
```

Or bypass for local dev:

```bash
KUZO_TRUST_ALL=true pnpm start:mcp
```

---

## 🧠 Wiring Kuzo into Claude

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kuzo": {
      "command": "node",
      "args": ["/absolute/path/to/seantokuzo-mcp/packages/core/dist/server.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "GITHUB_USERNAME": "your-username",
        "JIRA_HOST": "yourco.atlassian.net",
        "JIRA_EMAIL": "you@yourco.com",
        "JIRA_API_TOKEN": "..."
      }
    }
  }
}
```

**VS Code (Continue / Copilot MCP)** — same shape in `.vscode/mcp.json`. Each plugin is skipped gracefully if its required env vars aren't set, so you only need to provide credentials for what you actually want to use.

---

## 🧬 Plugin model

Every plugin implements `KuzoPluginV2`:

```ts
import type { KuzoPluginV2 } from "@kuzo-mcp/types";

const plugin: KuzoPluginV2 = {
  name: "my-plugin",
  description: "...",
  version: "1.0.0",
  permissionModel: 1,
  capabilities: [
    { kind: "credentials", env: "MY_TOKEN", access: "client", reason: "..." },
    { kind: "network", domain: "api.example.com", reason: "..." },
  ],
  tools: [ /* defineTool({...}) entries */ ],
  async initialize(context) { /* ... */ },
};
export default plugin;
```

The loader validates the manifest, checks consent, extracts scoped env vars, forks a child process, and wires an IPC-backed `PluginContext` (logger, credential broker, cross-plugin `callTool`). Plugins never import each other directly — cross-plugin calls route through `context.callTool()` and are gated by declared `cross-plugin` capabilities.

Full architecture spec: [`docs/PLANNING.md`](./docs/PLANNING.md). Security model + threat model: [`docs/SECURITY.md`](./docs/SECURITY.md).

---

## 📁 Monorepo layout

```
seantokuzo-mcp/
├── packages/
│   ├── types/              # @kuzo-mcp/types — shared types + defineTool helper
│   ├── core/               # @kuzo-mcp/core — server, loader, IPC, registry, broker, audit
│   ├── plugin-git-context/ # @kuzo-mcp/plugin-git-context
│   ├── plugin-github/      # @kuzo-mcp/plugin-github
│   ├── plugin-jira/        # @kuzo-mcp/plugin-jira
│   └── cli/                # @kuzo-mcp/cli — interactive kuzo binary
├── cli-bash/               # pure-bash twin for Node-less environments
├── docs/
│   ├── PLANNING.md         # architecture spec
│   ├── SECURITY.md         # security model + threat model
│   ├── 2.5e-spec.md        # active phase spec (monorepo + supply chain)
│   └── STATE.md            # session state + fresh-session handoff
└── pnpm-workspace.yaml
```

Tech stack: TypeScript 5.5+ (strict), Node 20+, ESM, Zod for tool-input validation, `@modelcontextprotocol/sdk` for the MCP protocol, `@octokit/rest` for GitHub, native `fetch` for Jira, pnpm workspaces + TS project references.

---

## ⚙️ Environment variables

| Variable | Plugin | Required | Description |
|---|---|---|---|
| `GITHUB_TOKEN` | github | for github | GitHub Personal Access Token |
| `GITHUB_USERNAME` | github | optional | Default owner for short repo names |
| `JIRA_HOST` | jira | for jira | Jira Cloud hostname (`yourco.atlassian.net`) |
| `JIRA_EMAIL` | jira | for jira | Email for Basic auth |
| `JIRA_API_TOKEN` | jira | for jira | Atlassian API token |
| `CLI_PERSONALITY` | cli | optional | `chaotic` (default), `professional`, `zen` |
| `KUZO_TRUST_ALL` | core | optional | `true` bypasses consent (dev only) |
| `KUZO_TRUST_PLUGINS` | core | optional | CSV of plugin names to trust without consent |
| `KUZO_STRICT` | core | optional | `true` = stored consent only, no trust overrides |
| `KUZO_NODE_PERMISSIONS` | core | optional | Enable Node's experimental permission model per child |

---

## 🛠️ Development

```bash
pnpm build              # tsc -b across all packages
pnpm typecheck          # same as build (composite projects need emit)
pnpm lint               # eslint .
pnpm -r run clean       # nuke all dist/

pnpm start:mcp          # node packages/core/dist/server.js
pnpm dev:cli            # tsx packages/cli/src/index.ts (requires prior build)
```

Before every commit: `pnpm typecheck && pnpm lint && pnpm build`.

---

## 🗺️ Roadmap

**Phase 2.5e — supply chain** (in progress)

- [x] Monorepo restructure (pnpm workspaces, scoped `@kuzo-mcp/*` packages)
- [x] Loader rewrite — package-name resolution with dev/installed dual-mode
- [ ] Dev-to-install parity test + CI no-cross-plugin lint rule
- [ ] Trusted publishing to npm via GitHub OIDC (tokenless)
- [ ] Pre-install provenance verification (sigstore + pacote)
- [ ] `kuzo plugins install/update/rollback` CLI

**Phase 3+ — more plugins**

- [ ] Apple TV plugin (Node.js control API research in progress)
- [ ] Calendar, SMS, Confluence, and whatever else turns out to be worth the squeeze
- [ ] Third-party plugin ecosystem once the install flow + provenance verification land

---

## 📜 License

MIT © Sean Tokuzo

---

_Built with 🔥, TypeScript, and aggressive process isolation._
