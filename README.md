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
- 🔐 **Encrypted credential store** — secrets live in an AES-256-GCM store keyed by the OS keychain (or a passphrase in headless mode), not in plaintext env blocks. Managed via `kuzo credentials set/list/rotate/delete/migrate`. `kuzo serve` decrypts at boot and scrubs secrets from the environment before forking plugin children.
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

# Provision credentials into the encrypted store (keyed to your OS keychain)
pnpm cli credentials set GITHUB_TOKEN
pnpm cli credentials set JIRA_API_TOKEN
# ...non-secret config (JIRA_HOST, JIRA_EMAIL, GITHUB_USERNAME) can stay in .env

# Boot the MCP server (stdio)
pnpm cli serve

# OR use the CLI directly
pnpm cli
```

Already have secrets in a `.env` or a `~/.claude/settings.json` env block? Pull them into the encrypted store in one shot:

```bash
pnpm cli credentials migrate   # imports + atomically redacts the sources
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

Install the CLI (`npm install -g @kuzo-mcp/cli`), provision your secrets once with `kuzo credentials set`, then point your client at `kuzo serve`. The config block no longer carries any secrets — `kuzo serve` decrypts them from the store at boot:

**Claude Desktop / Claude Code** — edit `~/Library/Application Support/Claude/claude_desktop_config.json` (or `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "kuzo": {
      "command": "kuzo",
      "args": ["serve"],
      "env": {}
    }
  }
}
```

**VS Code (Continue / Copilot MCP)** — same shape in `.vscode/mcp.json`. Each plugin is skipped gracefully if its credentials aren't provisioned, so you only need to `kuzo credentials set` what you actually want to use.

**Headless / no desktop keychain** (CI, remote box): set `KUZO_PASSPHRASE` in the server's environment so `kuzo serve` can unlock the store without a keychain prompt. Non-secret config (`JIRA_HOST`, `JIRA_EMAIL`, `GITHUB_USERNAME`) can still come from the `env` block or a `.env` file.

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
│   ├── 2.5e-spec.md        # supply-chain spec (shipped)
│   ├── credentials-spec.md # encrypted credentials + kuzo serve spec (shipped)
│   └── STATE.md            # session state + fresh-session handoff
└── pnpm-workspace.yaml
```

Tech stack: TypeScript 5.5+ (strict), Node 20+, ESM, Zod for tool-input validation, `@modelcontextprotocol/sdk` for the MCP protocol, `@octokit/rest` for GitHub, native `fetch` for Jira, pnpm workspaces + TS project references.

---

## ⚙️ Environment variables

Secrets (`GITHUB_TOKEN`, `JIRA_API_TOKEN`) belong in the encrypted store via `kuzo credentials set` — the table below documents the env-var names the store provisions, plus core/CLI knobs. A matching env var still works as an override for local dev, but `kuzo serve` scrubs them from the environment before forking plugin children.

| Variable | Plugin | Required | Description |
|---|---|---|---|
| `GITHUB_TOKEN` | github | for github | GitHub Personal Access Token (store via `kuzo credentials set`) |
| `GITHUB_USERNAME` | github | optional | Default owner for short repo names |
| `JIRA_HOST` | jira | for jira | Jira Cloud hostname (`yourco.atlassian.net`) |
| `JIRA_EMAIL` | jira | for jira | Email for Basic auth |
| `JIRA_API_TOKEN` | jira | for jira | Atlassian API token (store via `kuzo credentials set`) |
| `KUZO_PASSPHRASE` | core | headless | Unlocks the credential store without an OS keychain |
| `KUZO_DISABLE_KEYCHAIN` | core | optional | Force passphrase/null key provider instead of the OS keychain |
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

**Phase 2.5e — supply chain** (shipped)

- [x] Monorepo restructure (pnpm workspaces, scoped `@kuzo-mcp/*` packages)
- [x] Loader rewrite — package-name resolution with dev/installed dual-mode
- [x] Dev-to-install parity test + CI no-cross-plugin lint rule
- [x] Trusted publishing to npm via GitHub OIDC (tokenless) + Sigstore provenance
- [x] Pre-install provenance verification (sigstore + pacote)
- [x] `kuzo plugins install/update/rollback` CLI

**Phase 2.6 — encrypted credentials + `kuzo serve`** (shipped)

- [x] AES-256-GCM credential store keyed by OS keychain / passphrase
- [x] `kuzo credentials set/list/delete/rotate/status/test/wipe/migrate`
- [x] `kuzo serve` — parent-eager decrypt + env scrub before fork
- [x] Live rotation propagation (directory-watch cache invalidation)
- [x] Strict per-plugin env-name reservation + broker write-side audit

**Next — real-life QA, then more plugins**

- [ ] Bake-time: run the published `@kuzo-mcp/cli` as a daily-driver MCP server, file what surfaces
- [ ] Apple TV plugin (Node.js control API research)
- [ ] Hosted deployment + Claude.ai custom connector (SSE/HTTP transport)
- [ ] Calendar, SMS, Confluence, and whatever else turns out to be worth the squeeze

---

## 📜 License

MIT © Sean Tokuzo

---

_Built with 🔥, TypeScript, and aggressive process isolation._
