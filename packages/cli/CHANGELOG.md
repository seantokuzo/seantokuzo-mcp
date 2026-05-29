# @kuzo-mcp/cli

## 0.0.3

### Patch Changes

- [#58](https://github.com/seantokuzo/seantokuzo-mcp/pull/58) [`4d150e4`](https://github.com/seantokuzo/seantokuzo-mcp/commit/4d150e4fd78d5a51cf82c353e5c5a873ec6d5541) Thanks [@seantokuzo](https://github.com/seantokuzo)! - Phase 2.6 — encrypted credential store + `kuzo serve`.

  Credentials now live in an AES-256-GCM store keyed by the OS keychain (or a passphrase in headless mode), so `~/.claude/settings.json` no longer needs secrets — the canonical block is `{ "command": "kuzo", "args": ["serve"], "env": {} }`.

  Highlights:

  - **`kuzo credentials` command tree** — `set` / `list` / `delete` / `rotate` / `status` / `test` / `wipe` / `migrate`. `migrate` imports credentials from `~/.claude/settings.json` env blocks and project `.env` files into the encrypted store and atomically redacts the sources.
  - **`kuzo serve`** — friendly MCP server entry (stdio) that wraps `runServer()`. Parent-eager decrypt at boot, env scrub before forking plugin children, and a first-run summary on stderr.
  - **Live rotation propagation** — `kuzo credentials rotate` invalidates the running server's in-process decrypt cache via a directory watch + IPC refresh; first-party plugins pick up the new token on the next tool call without a restart (best-effort — see README "Backups"/"Recovery").
  - **Strict per-plugin env-name reservation** validated at install time; broker write-side audit events.

  **Breaking (pre-1.0, patch-bumped per the project's pre-1.0 cadence):**

  - `@kuzo-mcp/core`: `AuditLogger` is now an **interface**; the concrete file writer is the new `FileBackedAuditLogger`. External callers doing `new AuditLogger(...)` must switch to `new FileBackedAuditLogger(...)`.
  - `@kuzo-mcp/types`: new runtime export `isCredentialCapability`; new optional manifest hook `KuzoPluginV2.testCredential`.

  **Mixed-version gotcha:** `@kuzo-mcp/core@0.0.3` reads `kuzoPlugin.capabilities` statically from each plugin's `package.json`; `@kuzo-mcp/plugin-*@0.0.2` doesn't carry that field. Upgrade core and the plugins together.

  Run `kuzo credentials migrate` after upgrading; your existing `env:` block keeps working until you do.

- Updated dependencies [[`4d150e4`](https://github.com/seantokuzo/seantokuzo-mcp/commit/4d150e4fd78d5a51cf82c353e5c5a873ec6d5541)]:
  - @kuzo-mcp/types@0.0.3
  - @kuzo-mcp/core@0.0.3
  - @kuzo-mcp/plugin-github@0.0.3
  - @kuzo-mcp/plugin-jira@0.0.3

## 0.0.2

### Patch Changes

- Updated dependencies [[`6247d62`](https://github.com/seantokuzo/seantokuzo-mcp/commit/6247d620378a89edc7fbd6eef30511901fbfa92e)]:
  - @kuzo-mcp/plugin-github@0.0.2
  - @kuzo-mcp/plugin-jira@0.0.2
  - @kuzo-mcp/core@0.0.2
