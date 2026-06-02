# Phase 4 Spec — Remote Transport + AppleTV Plugin

> **Status:** Draft v2 (2026-06-01), revised after a 4-agent adversarial gap-hunt against the real codebase (`wf_dd8923f1-a9a`). Every external claim is fact-checked (`§12 Sources`); every codebase claim cites `file:line`.
>
> **Phase placement (resolved):** This is **Phase 4's first deliverable** — it ADDS *AppleTV* + the *remote-transport capability* it requires. `docs/PLANNING.md` Phase 4 ("New Integrations": confluence/discord/calendar/sms/…) lists **no** AppleTV and **no** remote transport today; this spec adds both to Phase 4 (update the PLANNING Phase 4 table accordingly). The broader integration grab-bag follows after. It does **not** "supersede" existing AppleTV bullets — there are none.

---

## 0. Context, goal, decisions

The goal is **regular Claude on the phone (claude.ai mobile app) controlling Sean's home Apple TV**. That forces a *remote* (HTTP) MCP server reachable from Anthropic's cloud, running at home (LAN access to the device), even though kuzo is stdio-only today.

### Locked decisions
- **pyatv-backed** (Python runtime dep), no native-TS reimplementation.
- **Phone is the point** — LAN-only/Claude-Desktop is dead; the remote/connector path is required.
- **Transport isolation = Option A** — a `bootKuzo()`/`buildMcpServer()` seam in core + a separate **opt-in `@kuzo-mcp/server-http`**; `kuzo serve --http` dynamically loads it; stdio stays zero-dep default.
- **No Hetzner/VPS/Caddy** — home-run **Cloudflare Tunnel** is the public front door.
- **tvOS = always latest** — accept bleeding-edge fragility; degrade gracefully.

### Non-goals
Away-from-home guarantees, guaranteed in-app content search, multi-user/multi-tenant, per-session tool scoping, mid-stream session resumption.

---

## 1. Architecture

```
  Claude phone app (claude.ai cloud, headless broker)
        │  HTTPS POST/GET  (MCP Streamable HTTP + OAuth 2.1 bearer)
        ▼
  Cloudflare Tunnel  (public https://appletv.<domain>; cloudflared runs AT HOME;
                      Bot Fight Mode MUST be disabled for this zone — §5/§9)
        │  localhost
        ▼
  kuzo serve --http  ── @kuzo-mcp/server-http (Streamable-HTTP transport + OAuth Resource Server)
        │  bootKuzo() ONCE → shared registry; buildMcpServer(registry) PER session
        ▼
  @kuzo-mcp/plugin-appletv  (runs in a forked child; declares credentials+network+system:exec)
        │  child_process spawn (REQUIRES --allow-child-process under permission mode — §3.2)
        ▼
  node-pyatv → atvremote/atvscript (Python pyatv, installed globally/pipx)
        │  Companion / AirPlay over the LAN
        ▼
  Apple TV (same wifi)
```

| Piece | Package | Reusable beyond AppleTV? |
|---|---|---|
| AppleTV plugin | `@kuzo-mcp/plugin-appletv` (new) | no |
| Core boot/transport seam | `@kuzo-mcp/core` (refactor `runServer`) | yes |
| HTTP transport + OAuth RS | `@kuzo-mcp/server-http` (new, opt-in) | **yes** — kuzo-as-a-connector for every plugin |
| Deploy | Cloudflare Tunnel + Docker | yes |

---

## 2. Build order (de-risked)

- **4a — Plugin over stdio.** `@kuzo-mcp/plugin-appletv` validated via `kuzo` over **stdio**; no HTTP/phone. **Prerequisite (must land first):** the `@kuzo-mcp/types` capability changes in `§3.3` (network-LAN + the manifest can't compile/pass parity without them).
- **4b — Boot seam + `@kuzo-mcp/server-http` (`--no-auth` dev mode).** Refactor `runServer` → `bootKuzo()`+`buildMcpServer()`; build the opt-in HTTP package; `kuzo serve --http` (loopback, `KUZO_DEV` gated).
- **4c — Public exposure + OAuth + claude.ai connector.** Cloudflare Tunnel (+ bot-protection off), the Authorization-Server decision (`§6`), appletv-only instance scoping, add the connector, prove OAuth via MCP Inspector **before** the phone.

QA (the `0.1.0` milestone) is **after 4c**.

---

## 3. Part A — `@kuzo-mcp/plugin-appletv`

### 3.1 Package shape (mirror `plugin-github`)
```
packages/plugin-appletv/
  package.json   # scoped name; @kuzo-mcp/types peer+devDep (locked #10); kuzoPlugin manifest mirror; postbuild check:manifest
  src/
    index.ts     # KuzoPluginV2 default export; version via createRequire(pkgJson); permissionModel: 1
    client.ts    # AppleTvClient — wraps @sebbo2002/node-pyatv NodePyATVDevice; OWNS teardown (§3.7)
    state.ts     # setClient/getClient/resetClient — BUT resetClient must call client.shutdown() (§3.7), unlike github's null-only reset
    types.ts     # plugin-owned types
    apps.ts      # name→bundle-id map + listApps()-backed resolver
    tools/{remote,playback,apps,nowplaying,power}.ts   # defineTool<S>(), Zod .describe() on every field
```
Follows every locked monorepo decision. Tools via `defineTool<S>()` (the github pattern); Claude-readable error strings.

### 3.2 pyatv runtime dependency + the permission-model blocker
- npm dep `@sebbo2002/node-pyatv@^9.0.3`; **Python ≥3.9 + pinned `pyatv==0.17.0` must be installed on the host** (`pipx install pyatv` or global pip — **NOT a venv**, see below). node-pyatv does not install it.
- **🔴 BLOCKER — Node Permission Model.** The plugin runs in a forked child (`plugin-process.ts`); when `KUZO_NODE_PERMISSIONS=true` the child is forked with `--experimental-permission` + `--allow-fs-read=…` but **no `--allow-child-process`** (`plugin-process.ts:204-222`). Under the permission model, `child_process` is denied by default → node-pyatv's spawn of `atvremote`/`atvscript` throws `ERR_ACCESS_DENIED`, and the `§3.2` startup probe is the **first** thing to fail (false "pyatv absent → skip"). **Resolution (core change, recommended):** when a plugin's manifest declares `SystemCapability{operation:"exec"}` (`§3.3`), the loader/plugin-process adds **`--allow-child-process`** to that child's `execArgv`. The `SystemCapability` type exists (`types/src/index.ts:60-66`) but is **not** wired into `execArgv` today — this is a real core/loader edit, flag for the Architecture+Security reviewers. **Fallback:** the deployed appletv-only instance runs with `KUZO_NODE_PERMISSIONS` unset (documented in `§5`).
- **Env reachability (child env allowlist).** The child only inherits `PATH/LANG/TERM/NODE_ENV/HOME/DEBUG` (`plugin-process.ts:87-94`); `PYTHONPATH/VIRTUAL_ENV/LC_*` are stripped. A **venv pyatv would silently fail.** ⇒ require pyatv installed **globally/pipx** (self-contained shebang on `PATH`); the Docker image (`§5`) installs it globally so `PATH` alone suffices. (Widening the allowlist is a core change; avoid it.)
- **Startup probe (skip-don't-crash):** on `initialize()`, spawn `atvremote --version`. Absent/unparseable → **skip with an actionable warning** ("Apple TV plugin disabled: pyatv not found — `pipx install pyatv`"), never crash. Log the detected pyatv version. (Under permission mode this probe only works once `--allow-child-process` is granted — above.)
- **Version drift:** node-pyatv parses `atvscript` JSON; pin pyatv; document the pinned version.

### 3.3 Capabilities (manifest) — three changes, one is a HARD types prerequisite
```ts
capabilities: [
  { kind: "credentials", env: "APPLETV_COMPANION_CREDENTIALS", access: "raw",
    reason: "Companion-protocol pairing token — nav, app launch, power" },
  { kind: "system", operation: "exec", command: "atvremote",
    reason: "Spawns the pyatv CLI to control the Apple TV" },          // ← REQUIRED; mirror git-context's git exec cap
  { kind: "network", scope: "lan", /* domain optional when scope=lan */ 
    reason: "Talks to the Apple TV over the local network (mDNS + IP)" }, // ← needs the types change below
],
optionalCapabilities: [
  { kind: "credentials", env: "APPLETV_AIRPLAY_CREDENTIALS", access: "raw", reason: "AirPlay token — power/playback on some setups" },
  { kind: "credentials", env: "APPLETV_HOST", access: "raw", reason: "Explicit Apple TV IP (skips mDNS)" },
  { kind: "credentials", env: "APPLETV_ID",   access: "raw", reason: "Apple TV identifier (multi-device)" },
],
```
- **🔴 `@kuzo-mcp/types` change (HARD PREREQUISITE, lands before 4a code).** `NetworkCapability` currently *requires* `domain: string` (`types/src/index.ts:35-40`); a `domain`-less manifest is a **TS compile error** and **fails `check:manifest`** (deep stable-stringify, `scripts/check-plugin-manifest-parity.mjs:105`), and `capabilityKey` keys network caps on `network:${cap.domain}` (`consent.ts:204`) → undefined breaks consent identity. **Fix:** add optional `scope?: "lan"` to `NetworkCapability` and make `domain` optional when `scope === "lan"`; update `capabilityKey`, the parity check, and any `isCredentialCapability`-style guards. **Honesty note:** the loader/plugin-process does **NOT enforce `NetworkCapability` at runtime at all** (it only reads `isCredentialCapability` + cross-plugin deps — `loader.ts:300-303,192-205`). So this change affects **manifest validation + consent display only**, not runtime network sandboxing. Don't claim runtime LAN enforcement that doesn't exist.
- **🔴 `system:exec` is REQUIRED**, not optional — the plugin shells out (git-context declares the analogous `git` exec cap). Add to both `src/index.ts` and the `package.json#kuzoPlugin` mirror so `check:manifest` stays green. AppleTV is the **first** plugin to exercise the `system` consent branch — verify consent rendering (`consent.ts:206-207`) + the parity gate handle it.
- **🔴 Do NOT add the pairing-token envs to `ALWAYS_SCRUB`.** `ALWAYS_SCRUB` = `[KUZO_PASSPHRASE, KUZO_NO_ENV_SCRUB]` only (`env-overrides.ts:24`) — deleted **unconditionally** (even under the kill-switch), **never delivered to plugins**, and **excluded from the `KUZO_TOKEN_<NAME>` twin handling** (`:117`). A cred there would (a) never reach the plugin and (b) leak its `KUZO_TOKEN_APPLETV_*` twin. **Declared `credentials` capabilities are already scrubbed** via the manifest-derived `declaredEnvNames` set and **re-delivered to the child** via the scoped broker Map (`server.ts:309-334`, `plugin-process.ts:196-199`). So: just declare them (done). The real ask is **logger/serialization redaction** so the strings are never logged — a separate concern.

### 3.4 Tool surface
**Reliable (Companion) — first-class:**
| Tool | node-pyatv | Notes |
|---|---|---|
| `appletv_remote` | `up/down/left/right/select/menu/home/topMenu/homeHold` | `key` enum arg |
| `appletv_playback` | `play/pause/playPause/stop/next/previous/skipForward/skipBackward` | `action` enum arg. **No `seek` on the device class** — CLI-only (`set_position`); defer/omit. |
| `appletv_launch_app` | `launchApp(bundleId)` + `apps.ts` resolver | name→bundle-id (`§3.5`); needs Companion |
| `appletv_list_apps` | `listApps()` → `App[]` **(`identifier`,`name`)** | NOT `{id,name}` — use `identifier` in `apps.ts` |

**Best-effort:**
| Tool | node-pyatv | Caveat |
|---|---|---|
| `appletv_now_playing` | **single `getState()`** | app-dependent; return honest "no metadata from the current app". **Never** fan out the ~25 granular getters (each spawns a process). Wrap in the `§3.7` timeout — it lazily spawns `atvscript` and **will hang** against an asleep TV like any command. |
| `appletv_power` | `turnOn/turnOff` | **⚠ verify protocol:** power may require AirPlay (which is *optional* here). If only Companion is paired and power needs AirPlay, return an actionable "power needs AirPlay pairing" error. Do not assert "reliable" without the protocol pin — confirm against the pyatv matrix in 4a; if AirPlay-dependent, classify best-effort. Reading power-state is separately unreliable with HomePod audio. |

≈6 tools — small surface (keeps the connector tool list lean). Every tool: Zod `.describe()`, Claude-readable errors.

### 3.5 App launch — name→bundle-id (`apps.ts`)
`launchApp` takes a **bundle id** (name-launch unsupported, pyatv #1442). Ship a static map (Netflix/YouTube/Apple TV/Disney+/Max/Hulu/Prime/Spotify/Plex…) → bundle ids + dynamic resolution: on a name miss, call `listApps()` (cache per session) and fuzzy-match `App.name` → `App.identifier`. No match → return the installed names so Claude retries.

### 3.6 Pairing & credentials
- **No pairing API in node-pyatv.** Pairing is a one-time interactive CLI step: `atvremote --id <ID> --protocol companion pair` → on-screen PIN; AirPlay pairs separately. We cannot automate the on-screen PIN.
- **Credential ownership — DECISION: kuzo-owned store (path a).** A new **`kuzo appletv pair` CLI command** (resolve open-Q #4 → CLI, not just a runbook) wraps the PIN flow and **writes the captured credential string into the Phase-2.6 encrypted store under the *same declared env key*** (`APPLETV_COMPANION_CREDENTIALS`), so the broker surfaces it to the plugin via `getRawCredential("APPLETV_COMPANION_CREDENTIALS")` (`credentials.ts:301-314`, requires `access:"raw"` — declared). The plugin passes it to node-pyatv via `companionCredentials`/`airplayCredentials` options. **Write path must be explicit:** confirm the store keys creds by the declared env name and a store-sourced cred is delivered into the scoped child Map identically to an env-sourced one.
- **Path (b) ~/.pyatv.conf is rejected** for the default: it reads a plaintext secret outside the store AND would require declaring a `FilesystemCapability{access:"read", path:"$HOME/.pyatv.conf"}` (`types/src/index.ts:43-49`) — extra consent surface for a plaintext secret. Prefer (a).

### 3.7 Resilience: process lifecycle, timeouts, error split (4a, not deferred)
node-pyatv's failure model + kuzo's child-process model create real side-effects the spec must handle:
- **Two error paths.** Commands **reject promises** (map to Claude-readable strings). Push/connection failures arrive as an **`'error'` EventEmitter event** — **unhandled `'error'` crashes the child process**, which the core then **respawns** (`plugin-process.ts:319-346`), masking a hard failure as a **restart loop**. ⇒ `client.ts` MUST attach a permanent `device.on('error', …)` **at construction** (4a, even without push subscription — `getState()` touches the same emitter), log + convert, never rethrow.
- **No built-in per-call timeout.** Wrap every spawned command in our own AbortController, default **10s** (well under the parent `TOOL_CALL_TIMEOUT_MS = 120_000`, `plugin-process.ts:61`). Bound concurrency to **1 in-flight per device** (a mutex; pyatv serializes anyway) — prevents unbounded spawns.
- **Kill grandchildren — no orphans.** node-pyatv spawns `atvremote`/`atvscript` grandchildren (the push path holds a long-lived `atvscript`, 15s auto-reconnect). On parent **SIGKILL** (heartbeat miss `plugin-process.ts:561`, shutdown escalation `:656`) or **crash-respawn**, those grandchildren are **not reaped** → orphaned LAN connections / leaked processes (exactly the high-likelihood `§9` tvOS-crash path). ⇒ (1) `client.shutdown()` calls `device.close()` and kills tracked pyatv child PIDs; (2) `state.resetClient()` must call `client.shutdown()` (unlike github's null-only reset); (3) spawn pyatv in a **tracked detached process group** and register a child-side `process.on('exit'/'SIGTERM')` reaper so a parent SIGKILL doesn't orphan them.
- **Graceful tvOS degradation** (#2656 class): catch connection-lost (Companion can die on a new tvOS while AirPlay survives), return "Apple TV control unavailable — pyatv may need updating for your tvOS"; don't hard-fail the plugin.

### 3.8 Now-playing
4a ships a **snapshot tool** (single `getState()`), not a live subscription. The EventEmitter push/streaming model is later work. **Prompt-injection:** now-playing/app-name text is untrusted — fence it as data in tool output, never as instructions.

---

## 4. Part B — core boot/transport seam + `@kuzo-mcp/server-http`

### 4.1 The core refactor (bigger than "edit runServer" — be honest)
Today `runServer` (`server.ts:266`) does the **entire one-shot boot inline** — config, consent/audit, key provider + credential store decrypt, `collectEnvOverrides` → `scrubProcessEnv` (deletes cred env from `process.env`, step 7) → `loader.loadAll` (parent-eager decrypt) → **`freezePrototypes` (irreversible, process-wide, `:378`)** → rotation watcher → builds **one low-level `Server`** (`Server` from `…/server/index.js`, **NOT `McpServer`** — `:30,:118`) via the private `buildMcpServer(registry, logger)` → connects **one `StdioServerTransport`** (`:524`). The registry/loader/store are **locals trapped in `runServer`'s closure**; nothing is exported but `runServer` + `RunServerOptions`. **Boot is unrepeatable** (scrub already deleted creds; freeze can't re-run).

**Refactor:**
1. Extract **`bootKuzo(options): Promise<{ registry, logger, shutdown }>`** — runs all boot steps **exactly once**, returns the shared handle (`shutdown` does `loader.shutdownAll()` + registry shutdown + watcher close).
2. Export **`bootKuzo`** and **`buildMcpServer(registry, logger): Server`** from a `@kuzo-mcp/core/server` subpath (add to the package `exports` map).
3. `runServer` becomes: `const h = await bootKuzo(opts); buildMcpServer(h.registry, h.logger).connect(new StdioServerTransport())` + signal handling → `h.shutdown()`. **Zero behavior change for the stdio path** (re-run the 2.5e parity test + typecheck/build to prove it).

### 4.2 `@kuzo-mcp/server-http` (new, opt-in)
- **SDK version:** target the **already-installed `@modelcontextprotocol/sdk` (currently `1.25.3` via core's `^1.0.0`, lockfile-pinned)** — every API below exists at 1.25.3. **Do NOT pin 1.29.0** (would force a core SDK bump affecting the shipped stdio path; if ever bumped, re-run parity/typecheck/build). **Do NOT design against the v2 typedoc / repo `main`** — that's an unreleased split-package (`@modelcontextprotocol/node`, `@modelcontextprotocol/express`). The SDK already bundles `express@^5`, `cors`, `jose` as deps — reuse them; don't re-pin separately (avoid version drift).
- **Boot once, serve per session:** `bootKuzo()` runs **once** at server-http startup (single decrypt/scrub/loadAll/freeze, before the listener binds). Per HTTP session: `buildMcpServer(registry, logger)` (the low-level `Server`) `.connect(transport)`. The registry/loader/store are **shared singletons**; sessions differ only in their transport + `Server` wiring. The tool list is **process-global** (`registry.getAllTools()`, `server.ts:124-132`) — same for all sessions, **no per-session scoping** (fine for the appletv-only instance via config-disable).
- **Transport:** `StreamableHTTPServerTransport` (`…/server/streamableHttp.js`), **stateful** (`sessionIdGenerator: () => randomUUID()`), per-session transport map keyed by `Mcp-Session-Id`. `POST /mcp` (reuse-or-create-on-initialize, `onsessioninitialized`/`onsessionclosed` register/cleanup; 404 unknown session, 400 non-init w/o id), `GET /mcp` (SSE/resume), `DELETE /mcp` (terminate). Use **`createMcpExpressApp({ host, allowedHosts })`** for DNS-rebinding (Host-header) protection — the transport-level `allowedHosts`/`enableDnsRebindingProtection` flags are **deprecated**. **No `eventStore`** (no resumability) for v1.
- **CORS:** add `cors()`, `exposedHeaders: ['Mcp-Session-Id']`, and `allowedHeaders` MUST include **`Mcp-Protocol-Version`** (transport rejects post-init requests without it), `Authorization`, `Content-Type`, `Accept`, `Last-Event-ID`. (CORS is browser-only and is **not** a security boundary for the headless connector — `§6`.)
- **Stateful caveat:** sessions are **in-memory, single-process** → a Docker/`cloudflared` restart drops all sessions; the next client call gets **404** and claude.ai re-initializes automatically. Acceptable for one user; rules out horizontal scaling. Document it.
- **`kuzo serve --http [--port] [--host]`** in `@kuzo-mcp/cli`: dynamic `import("@kuzo-mcp/server-http")` (proven pattern — `serve.ts:44` already dynamic-imports `@kuzo-mcp/core/server`). On failure, **match `ERR_MODULE_NOT_FOUND` AND verify the missing specifier is `@kuzo-mcp/server-http`** before printing "run `npm i -g @kuzo-mcp/server-http`"; **rethrow** anything else (a partially-broken install throws `ERR_PACKAGE_PATH_NOT_EXPORTED`/native-module errors — don't mask them). No hard dep in the CLI.

### 4.3 Auth = Resource-Server only (the AS is external — `§6`)
The MCP server is an OAuth 2.1 **Resource Server**; it **verifies** tokens, it is **not** the AS. SDK gives the RS half: `requireBearerAuth({ verifier, requiredScopes?, resourceMetadataUrl })`, `mcpAuthMetadataRouter(...)` (serves RFC 9728 protected-resource + re-advertises the external AS's RFC 8414 metadata), `getOAuthProtectedResourceMetadataUrl(...)`. **The SDK ships NO Authorization Server** (`mcpAuthRouter`/`ProxyOAuthServerProvider` only route/advertise/proxy — no token minting, no login UI). So `@kuzo-mcp/server-http` is RS-only: mount `mcpAuthMetadataRouter`, protect `POST /mcp` with `requireBearerAuth`, our **`verifyAccessToken`** (JWT verify via `jose` or AS introspection) — see `§6` for the audience check. Until the AS is chosen, ship `--no-auth` as a **hard `KUZO_DEV` gate** (`§6.2 D`).

### 4.4 Build vs wire (corrected effort)
- **Core boot/transport refactor:** real work — extracting `bootKuzo` from a 250-line security-critical closure + exports-map change + parity re-verify. **Not** "60 lines of Express glue."
- **HTTP transport + sessions:** ~SDK wiring once the seam exists (~60 lines Express).
- **Auth metadata + token verify:** SDK wiring + our `verifyAccessToken`.
- **Authorization Server:** **external** — the real cost, gated to 4c (`§6`).

---

## 5. Part C — deployment & connector
- **Run at home in Docker** on a box on the Apple TV's LAN; image bundles Node + **Python + pinned pyatv (global, not venv)**. Networking: prefer **host networking** (mDNS/Bonjour across Docker bridges is finicky) **or** a bridge + explicit `APPLETV_HOST` (skip discovery). Run with `KUZO_NODE_PERMISSIONS` unset unless the `--allow-child-process` core change (`§3.2`) lands.
- **appletv-only instance scoping (critical):** only the appletv plugin enabled, **zero dev credentials** (no GitHub/Jira). Worst-case compromise = poke the TV, not the dev tokens.
- **Cloudflare Tunnel** (`cloudflared` from home): free, no VPS, public `https://appletv.<domain>` → localhost; publicly-trusted TLS at the edge (satisfies HTTPS). **🔴 Disable Bot Fight Mode / Super Bot Fight Mode / "Block AI training bots" (or add a WAF skip rule) on this zone** — Cloudflare's bot protection drops Anthropic's *headless server-to-server* broker requests (documented: `claude-ai-mcp#49`); without this, 4c **cannot** pass. (The earlier "must come from Anthropic IPs" claim was *refuted* — bot-mode is the real gotcha, not an IP allowlist.)
- **Host containment (`§6`):** run `cloudflared` as a separate least-privilege service where feasible; the `cloudflared` token is itself a secret; a host-networked container is a LAN foothold if compromised — prefer a bridge + `APPLETV_HOST` if mDNS can be satisfied.
- **claude.ai connector:** Settings → Connectors → add by URL `https://appletv.<domain>/mcp`. Web-config syncs to iOS/Android (the phone path ✅). Free plan = 1 connector. Zero pasted secret **only if** the AS supports DCR/CIMD (`§6.2`).

---

## 6. Security model & the Authorization-Server decision

### 6.1 "Only my Claude"
Public endpoint ⇒ auth mandatory; the URL is not a secret. **OAuth 2.1 + S256 PKCE** binds it: claude.ai authenticates against an AS that **only authorizes Sean**, gets a scoped/expiring token; the server **validates the audience (RFC 8707)**. IP-allowlisting Anthropic does **not** mean "my Claude" (shared egress) — defense-in-depth only.

### 6.2 Authorization Server — DECISION POINT (resolve in 4c, criteria now)
SDK has no AS. **Hard selection requirement:** the AS MUST support **RFC 7591 DCR or claude.ai CIMD with a `registration_endpoint` advertised in RFC 8414 metadata** — otherwise the "no pasted secret" UX is impossible and Sean must paste a Client ID/Secret (the connector's Advanced settings expose only OAuth Client ID/Secret — there is **no static-bearer field**, so a plain static token is **not** an option).
- **(A) Managed AS** (Auth0/WorkOS/Stytch/Clerk/etc.) — **verify DCR/CIMD per candidate** (several gate or omit DCR). Lock the allowed identity to Sean. **Recommended**, contingent on DCR/CIMD.
- **(B) Cloudflare Access — REJECTED for the connector path.** It demands an interactive browser SSO redirect; claude.ai's broker is headless server-to-server and never performs it, and CF Access service-tokens need custom `CF-Access-Client-*` headers the connector can't send. Usable only as a coarse human gate during manual 4b testing — **never** the 4c answer.
- **(C) Minimal self-hosted AS** (implement the SDK `OAuthServerProvider`): full control, no external dep, but large + security-sensitive. Not recommended unless (A) is unacceptable.
- **(D) `--no-auth` dev flag — HARD-GATED, loopback only.** Mirror the real `--no-scrub` enforcement (`serve.ts:33-39` *refuses to boot* without `KUZO_DEV=1` and exits non-zero): `--no-auth` **requires `KUZO_DEV=1`, refuses to boot otherwise, and forces the listener to `127.0.0.1` (rejects a non-loopback `--host`)**. Never the public answer.

**Recommendation:** 4b uses (D); 4c adopts (A) with a DCR/CIMD-verified managed AS scoped to Sean. This is the biggest open risk, deliberately isolated to 4c.

### 6.3 Token verification (RFC 8707 audience — concrete)
The protected-resource-metadata `resource` = **`https://appletv.<domain>/mcp`** (must match the URL Sean enters in Claude exactly, incl. path). `verifyAccessToken` MUST (a) verify signature/expiry against the AS JWKS (or introspect), and (b) assert the token `aud`/`resource` **equals that canonical URL**, rejecting mismatches with **401 + `WWW-Authenticate: Bearer resource_metadata=<getOAuthProtectedResourceMetadataUrl(...)>`**. The server MUST NOT pass the received token through.

### 6.4 Other controls
- Bind loopback; expose only via the tunnel; DNS-rebinding protection on; rate-limit. **CORS Origin is browser-only — not a security boundary** for the headless broker (keep it permissive enough for the MCP Inspector during 4c).
- Pairing tokens: declared credentials (auto-scrubbed + broker-delivered); add to **logger redaction** (never log the strings or `~/.pyatv.conf`). NOT `ALWAYS_SCRUB` (`§3.3`).
- Prompt-injection: fence now-playing/app text as data.

---

## 7. `@kuzo-mcp/types` & contract changes (land BEFORE 4a code)
1. **`NetworkCapability` LAN** (`§3.3`): add `scope?: "lan"`, make `domain` optional when `scope==="lan"`; update `capabilityKey` (`consent.ts:204`), the manifest-parity check (`check-plugin-manifest-parity.mjs`), and capability guards. **Manifest/consent-display + parity only — no runtime network enforcement exists.**
2. **`SystemCapability{exec}` wiring** (`§3.2`): wire a declared `system:exec` capability to add `--allow-child-process` to the child's `execArgv` in `plugin-process.ts` (core/loader change; first real use of `SystemCapability`).
3. No new `AuditAction` expected (control/read, not credential mutation) — confirm in 4a.

---

## 8. Acceptance criteria
- **Types prereq:** `NetworkCapability` LAN shape + `system:exec`→`--allow-child-process` land; `check:manifest` green; 2.5e parity test green.
- **4a:** pyatv-absent → skip with clear warning (server boots). Under `KUZO_NODE_PERMISSIONS=true`, the exec-declaring plugin's spawns succeed (`--allow-child-process` granted). Paired device → nav/playback/launch-app/list-apps work over stdio; now-playing returns metadata or honest "unavailable" via a **single** `getState()`; every command has a 10s timeout + 1-in-flight mutex; unreachable device → Claude-readable error (no hang); **an injected `'error'` event does NOT restart-loop the child**; **no orphaned `atvremote`/`atvscript` after shutdown or N induced crash-respawns**; manifest-parity + `typecheck`/`lint`/`build` green; `node:test` for the name→bundle-id resolver + error mapping (mock the `spawn` hook).
- **4b:** default `pnpm install` pulls **no** HTTP/OAuth deps; `bootKuzo`/`buildMcpServer` refactor leaves the stdio path byte-behavior-identical (parity green); `kuzo serve --http` without the package prints the install hint (and rethrows non-MNF errors); with it, a client completes `initialize` + a tool call over Streamable HTTP on loopback; DNS-rebinding protection active; session 200/404/400 behave per spec; **`--no-auth` refuses to boot without `KUZO_DEV=1` and refuses a non-loopback host**.
- **4c:** Bot protection disabled on the zone; **OAuth + audience-verify proven via MCP Inspector/curl against the public URL FIRST**; then Sean's phone drives the Apple TV end-to-end; a wrong-audience token → 401; the exposed instance has no dev credentials; tunnel-down / device-asleep → clear errors.

---

## 9. Risks
- **claude.ai connector OAuth fragility (high, Anthropic-side):** open bugs where OAuth completes but the bearer token is never attached (`claude-code#46140`, `claude-ai-mcp#215`). Mitigation: prove server correctness via MCP Inspector first; final E2E depends on Anthropic.
- **Cloudflare bot-mode dropping the broker** (`§5`) — disable it.
- **tvOS-latest fragility** (#2656 class) — pin/track pyatv, degrade gracefully, accept breakage windows.
- **Authorization Server complexity + DCR availability** (`§6.2`) — the real unknown; isolated to 4c.
- **Core boot refactor touches the shipped stdio path** — parity-test it.
- **Orphaned pyatv grandchildren / permission-model spawn** (`§3.2`,`§3.7`) — the two most kuzo-specific gotchas.
- **Python/Docker packaging; mDNS across Docker; SDK churn (v2 split unreleased).**

---

## 10. Open questions (most resolved above; remaining)
1. AS choice + DCR/CIMD verification per candidate (4c).
2. `appletv_power` protocol dependency (Companion-only vs needs-AirPlay) — confirm in 4a.
3. CIMD client_id-document constraints, if CIMD over DCR (4c verify).
4. Whether `--allow-child-process` is gated purely on `SystemCapability{exec}` or also needs a `command` allowlist match.

(Resolved: credential ownership → store/`kuzo appletv pair` CLI; pairing → CLI command; transport seam → `bootKuzo`+`buildMcpServer`; SDK version → installed 1.25.3; CF Access → rejected; ALWAYS_SCRUB → not used; phase number → Phase 4 addition.)

---

## 11. Phase placement
Phase 4 ("New Integrations") gains **two** things: the **remote-transport capability** (`@kuzo-mcp/server-http` + the `bootKuzo` seam) and **AppleTV** as its first integration. Add both to the `docs/PLANNING.md` Phase 4 section (currently confluence/discord/calendar/sms/…). Sequence: types prereq → 4a → 4b → 4c → QA (`0.1.0`).

---

## 12. Sources (fact-checked)
- Codebase: `packages/core/src/server.ts` (`runServer`/`buildMcpServer`/boot order/freeze/scrub), `plugin-process.ts` (fork, permission-model execArgv `:204-222`, env allowlist `:87-94`, heartbeat/timeout/kill), `loader.ts` (capability handling), `consent.ts` (`capabilityKey`), `credentials/env-overrides.ts` (`ALWAYS_SCRUB`), `credentials.ts` (`getRawCredential`), `types/src/index.ts` (capability union), `scripts/check-plugin-manifest-parity.mjs`, `plugin-github`/`plugin-git-context` (plugin + exec-cap patterns), `cli/.../serve.ts` (dynamic import + `--no-scrub` gate). Verified by gap-hunt `wf_dd8923f1-a9a`.
- claude.ai connector + MCP auth/transport: deep-research `wf_c67cc9f0-095`, `wf_01b004d6-e7f` (MCP spec 2025-03-26/06-18/11-25, claude.com/docs/connectors, support.claude.com). Streamable HTTP, OAuth 2.1 + S256 PKCE, RFC 9728 PRM, RFC 8707 audience, DCR/CIMD, no static-bearer field, plan/mobile sync.
- MCP TS SDK (installed 1.25.3): workflow `wf_c13e4ce2-249` — `StreamableHTTPServerTransport`, `createMcpExpressApp`, `requireBearerAuth`, `mcpAuthMetadataRouter`/`getOAuthProtectedResourceMetadataUrl`; SDK is not an AS; v2 docs unreleased.
- node-pyatv 9.0.3 / pyatv 0.17.0: workflow `wf_c13e4ce2-249` — `NodePyATVDevice` surface, `App.identifier`/`name`, EventEmitter push (lazy/ref-counted/15s reconnect), no pairing API, error split, no device-class seek, Python dep, #2656.
- Cloudflare bot-mode + connector OAuth bugs: gap-hunt `wf_dd8923f1-a9a` (claude-ai-mcp#49/#112/#215, claude-code#46140).
