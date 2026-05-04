# Credentials Spec Brief

> **Input** for the next research/spec session. Modeled on `docs/2.5e-spec.md`'s shape but **inverted** — this is the brief the spec session reads cold and turns into `docs/credentials-spec.md` (the implementation north star).

**Status:** Brief — research not yet started. Locked input as of 2026-05-04. Edits land in the eventual spec doc, not here.

**Predecessor research:** `docs/SECURITY.md` §6 ("Credential Broker") drafted the broker interface + a phased storage plan. The broker shipped (Phase 2.5a). Storage upgrade was deferred to "Phase 2.5d+" but never landed inside the actual 2.5d/2.5e work. **That deferral is what this spec session resolves.**

---

## 0. Why this is the next phase

We are about to use the published `@kuzo-mcp/cli@0.0.2` for real-life QA via Claude Code (per the locked next-session plan in `docs/STATE.md`). Walking the actual user flow surfaced three gaps that block meaningful bake-time:

1. **No credential provisioning UX.** `kuzo plugins install github` (`packages/cli/src/commands/plugins/install.ts:1-22`) walks consent + verification + atomic commit but **never collects a token**. There is no `kuzo init`, no inline prompt, no docs telling a fresh user "set `GITHUB_TOKEN` before launching the MCP server." Plugin loads silently skip when the env var is missing.
2. **Plaintext on disk in two places.** Tokens live in either a `.env` file (mode 644, dotenv-loaded by `ConfigManager.loadDotenv()` at `packages/core/src/config.ts:33-49`) or a `~/.claude/settings.json` `env` block (mode 644). Both are world-readable to any process under the user account, both get sucked into Time Machine / iCloud / dotfiles repos.
3. **No isolation knobs for parallel installs.** `KUZO_PLUGINS_DIR` (`packages/cli/src/commands/plugins/paths.ts:21-23`) redirects the plugin tree, but `~/.kuzo/consent.json` is hardcoded (`packages/core/src/consent.ts:46`), and there's no `KUZO_HOME` / `KUZO_CONFIG_DIR`. Two installs on the same user share consent state.

Bake-time on a "credentials are broken" surface area teaches us nothing we don't already know. Front-load the spec, ship it, then QA the credentialed-properly install.

This is **also** the gating phase for any third-party plugin distribution — a malicious plugin loaded today gets full `process.env` access via the dotenv-populated map, regardless of what its manifest declares. The broker can refuse to *serve* the credential to the plugin via `getRawCredential` / `getClient`, but the value is still in the same `process.env` the plugin's code can read directly. **The broker is necessary but not sufficient until the credential never enters `process.env` in the first place.**

---

## 1. Current state — what shipped, what didn't

### What's already done

**Credential broker (designed + implemented):**

- Interface: `CredentialBroker` in `packages/types/src/index.ts:103-131`. Three access modes: `client`, `authenticated-fetch`, `raw`.
- Implementation: `DefaultCredentialBroker` in `packages/core/src/credentials.ts:88-252`. Per-plugin scoped config map, capability-gated access, audit-logged on every read. URL-pattern enforcement on `authenticated-fetch`. First-party client factories hardcoded for `github` + `jira` (`credentials.ts:35-69`).
- Manifest type: `CredentialCapability` in `packages/types/src/index.ts:16-32`. Plugins declare which env var names they need + which access mode for each + a `reason` string surfaced during consent.
- Consent flow: `ConsentStore` (`packages/core/src/consent.ts`) snapshots granted/denied capabilities, re-prompts on plugin upgrade or capability changes.
- Audit: `AuditLogger` records `credential.client_created`, `credential.raw_access`, `credential.raw_denied`, `credential.fetch_created`. Lives at `~/.kuzo/audit.log`.

**Plugin migration:** all three first-party plugins consume credentials via the broker. `requiredConfig`/`optionalConfig` are gone (per SECURITY.md §6 migration step 4, marked DONE in PR #13).

### What didn't ship

**Storage backend.** `ConfigManager` reads `process.env` and shoves matching keys into the per-plugin `Map<string,string>` that initializes the broker. The broker is fed plaintext from env. There is no keychain integration, no encrypted-on-disk, no provisioning flow.

**Per-plugin process isolation.** Tracked separately in issue #26. Out of scope for this phase (but the credential design should not foreclose it — see §10).

**Provisioning CLI.** No `kuzo credentials set <name>`, no `kuzo init`, no inline prompt at the end of `kuzo plugins install`.

**`~/.claude/settings.json` zero-secrets contract.** Today users put tokens in the `env` block of the MCP server entry. Plaintext, owned by editor, screenshare-leakable.

**Headless / CI fallback.** Keychain doesn't work without a desktop session on Linux; macOS keychain prompts on every unsigned-Node read until "Always Allow" is set. We have no documented fallback policy.

**Friendly MCP server entry.** The user wires `node <prefix>/lib/node_modules/@kuzo-mcp/core/dist/server.js` into `~/.claude/settings.json`. There is no `kuzo serve` / `kuzo-mcp` binary that abstracts the path. This is a UX adjacent finding worth solving in the same phase since the entry is also where credentials get supplied today.

**Third-party client factory registration.** `getClient<T>()` only works for `github` + `jira` because the factory map is a hardcoded const. Option B from SECURITY.md §6 (plugin registers factory) is unbuilt.

**Isolation env knobs:** only `KUZO_PLUGINS_DIR` exists. Need at least `KUZO_HOME` (overrides `~/.kuzo/`) so consent + audit + tuf-cache + plugins all redirect together. Slot in here since we're touching the directory contract.

---

## 2. Threat model — what we're defending against

Inherits SECURITY.md §2 and adds the storage-specific vectors:

1. **Local malware running as the user account.** The dominant real-world threat for personal MCP. Plaintext on disk → token gone. Keychain raises the bar (per-app ACL with macOS prompt, encrypted at rest with login keychain).
2. **Malicious plugin (post-Sigstore).** Sigstore proves "who published" + "what was built," not "is the author trustworthy." A signed-but-evil plugin reads `process.env` on init and exfils. The broker cannot defend against this until the credential never enters `process.env`.
3. **Backups + screenshare + dotfiles commits + cloud sync.** Plaintext-on-disk eats all of these. Keychain entries are not in the home dir tree most backup tools index.
4. **Disk theft with FileVault off / shared dev machines.** Plaintext = game over. Keychain entries are encrypted with the login password so disk theft alone is insufficient.
5. **`ps` / shell history.** Anything inline-passed (`GITHUB_TOKEN=... kuzo serve`) leaks via `ps aux` and `~/.zsh_history`. Provisioning UX must avoid CLI args for secrets.
6. **Prompt-injection extraction via tool calls.** Less about storage, more about tool surface (we don't expose "send arbitrary HTTP"). The broker's `authenticated-fetch` URL-pattern gate (already shipped) is the primary mitigation; storage doesn't change this.

Vector 2 is the one that genuinely blocks third-party plugin distribution. Vectors 1, 3, 4 are the user-visible "your tokens aren't sitting in plaintext" promise that has positioning value.

---

## 3. Storage options — design space the spec session must traverse

### Tier 1 — OS keychain (recommended starting point per SECURITY.md §6)

macOS Keychain / Windows Credential Manager (DPAPI) / Linux Secret Service (libsecret / gnome-keyring / kwallet). Per-app ACL, encrypted at rest with the user's login keychain. macOS prompts the user on first read.

Node bindings:

| Binding | Status | Notes |
|---|---|---|
| `keytar` | **Archived** (2024) | Atom-era, npm dropped maintenance. SECURITY.md §6 calls this out. |
| `@napi-rs/keyring` | **Recommended** in SECURITY.md §6.5 | v1.2.0, ~77k weekly downloads, Rust binding, no libsecret runtime dep on Linux. Maintained. |
| `node-keytar` forks | Various | Don't use — rebadged abandonware. |
| Custom shell-out (`security`, `secret-tool`, `cmdkey`) | Possible | Avoids native dep at cost of UX (passwords visible in `ps` argv on some platforms). |

**The macOS unsigned-Node binary problem.** Keychain entries are scoped to the calling binary's bundle ID + code signature. Unsigned Node (the typical npm-installed `node`) gets a generic identity, so the user sees "node wants to access kuzo's keychain" prompts that look scary. "Always Allow" sticks per binary path. Mitigations to research: ship our own signed helper binary (`gh`'s approach), accept the friction with clear docs, or use the macOS Keychain group entitlement.

**Linux headless.** No secret-service daemon on bare servers, SSH sessions, CI. Spec must define an explicit fallback (see Tier 2).

### Tier 2 — Encrypted-on-disk

Spec must decide between:

| Approach | Notes |
|---|---|
| **Age / `age`-encrypted file**, key passphrase from the user | Cross-platform, no native dep. Worse UX (passphrase per launch unless cached). |
| **SOPS** with age/PGP recipients | Heavier, designed for shared secrets, overkill for personal. |
| **AES-encrypted `.kuzo/credentials.enc` with key in OS keychain** | Hybrid — best of both. Backup-safe (file is ciphertext) and unlock-invisible (key is in keychain). Probably the right v1 answer if Tier 1 alone has UX warts. |
| **`pass` / `gopass`** | UNIX nerd-friendly, GPG-based, requires the user to have set it up. Not a default; valid as a `KUZO_CRED_BROKER=pass` opt-in. |

### Tier 3 — Broker improvements (inside `DefaultCredentialBroker`)

Already-shipped broker is good but has gaps:

- **Third-party client factory registration.** Option B from SECURITY.md §6.4. Plugin registers a factory at install time; factory runs in core context, plugin still never sees the raw token.
- **Scrub `process.env` after broker init.** Today `process.env.GITHUB_TOKEN` is still set for the entire server lifetime. A malicious plugin loaded later reads it directly. After the broker has a copy, `delete process.env.GITHUB_TOKEN` (or assign empty string) closes that hole. Spec must check this doesn't break dotenv-aware libraries the plugins import.
- **Lazy fetch.** Today the broker is initialized with the full Map at plugin-load time. Lazy fetch (broker pulls from keychain on first `getClient` / `getRawCredential` call) lets us defer keychain prompts until the plugin actually needs the token, not at every server boot. UX win.
- **Per-credential audit retention.** Audit log already records reads — does it grow unbounded? Spec the rotation policy.

### Tier 4 — External secret managers (opt-in fallback)

- **1Password CLI:** `op run -- kuzo serve` injects secrets at process spawn. Works today as a workaround; spec should formalize as a documented `KUZO_CRED_BROKER=op` mode that signals to the MCP server "trust process.env, don't read keychain."
- **HashiCorp Vault / cloud KMS:** enterprise. Don't ship. Mention in the spec only as "we don't preclude this" — the broker shape supports it via the same external-process pattern.

### Orthogonal — Short-lived tokens

GitHub-specific but illustrative for any plugin authenticating against an OAuth-shaped service:

- **GitHub App installation tokens** (1-hour lifetime, refreshable). Drops blast radius on leak by ~99%. Adds a refresh dance + GitHub App registration flow + JWT signing in the broker.
- **Default stays PAT** for friction reasons. Apps are an opt-in `kuzo credentials set GITHUB_APP --type=app` flow.

Spec must decide whether GitHub App support is in v1 or deferred — recommend deferred unless the research surfaces an unexpectedly simple integration.

---

## 4. Constraints from the existing system

The spec **must** preserve these. Re-litigating them is out of scope.

1. **`CredentialBroker` interface stays.** `getClient` / `createAuthenticatedFetch` / `getRawCredential` / `hasCredential` are the contract. Plugins consume credentials through this surface. Storage changes happen behind the broker.
2. **Capability model stays.** `CredentialCapability` (`packages/types/src/index.ts:16-32`) is the manifest declaration. The consent flow renders these. Plugin manifest changes are additive only.
3. **Audit log shape stays compatible.** New `credential.*` actions are fine; renaming or removing existing ones breaks `~/.kuzo/audit.log` parseability.
4. **`KUZO_PLUGINS_DIR` env override stays.** Add new envs (`KUZO_HOME`, `KUZO_CONFIG_DIR`, `KUZO_CRED_BROKER`); don't remove existing ones.
5. **Plugin contract: no cross-plugin imports.** All credential access flows through `PluginContext.credentials`. The broker is the only path; plugins do not import `@kuzo-mcp/core/credentials` directly. (Loader test enforces this.)
6. **Sigstore-verified ≠ trusted.** The broker does not get more permissive based on package provenance. A signed plugin still gets exactly what its manifest declares.
7. **No singletons.** Broker is per-plugin, instantiated by the loader, scoped via constructor injection. (Already true; preserve.)
8. **Process isolation is a future phase, not a precondition.** Issue #26 is the natural follow-up. The credential design should make process isolation strictly easier — moving credentials out of `process.env` is exactly what the host-process model needs. Don't design something that fights it.

---

## 5. Open questions the spec session must land on

Numbered for cross-reference. Each gets a recommended default; spec session can override with reasoning.

1. **Primary keychain binding.** `@napi-rs/keyring` (recommended per SECURITY.md §6) vs shell-out via `security`/`secret-tool`/`cmdkey`. Trade native-dep complexity vs UX cleanliness.
2. **macOS prompt-storm mitigation.** Accept friction + docs (default), ship signed helper binary, or research keychain access groups.
3. **Linux headless / CI fallback.** Encrypted-file-with-passphrase, encrypted-file-with-`KUZO_PASSPHRASE`-env, plain env-var fallback with audited warning, refuse-to-start. Recommended: explicit `KUZO_CRED_BROKER=env` opt-in with startup banner + audit entry.
4. **At-rest encryption when keychain available.** Always-keychain (Tier 1 only) vs hybrid (Tier 2 ciphertext file with key in keychain). Recommended: Tier 1 only for v1, hybrid as a fast-follow if backup-leak concerns surface.
5. **`process.env` scrubbing.** Delete from env after broker reads, leave it, or leave it but log the read. Recommended: delete after read, with a kill-switch env (`KUZO_NO_ENV_SCRUB=1`) for the dotenv-library-collision case.
6. **Provisioning UX shape.** `kuzo init` (one-shot first-run) vs `kuzo credentials set <name>` (per-credential) vs inline-with-`plugins install` (prompt right after consent succeeds) vs all three. Recommended: inline-with-install + `kuzo credentials set` for rotation. No `kuzo init` (over-engineered for our current footprint).
7. **`~/.claude/settings.json` migration.** Hard refusal ("the MCP server refuses to start if `env` block contains a known credential name"), warn-but-continue, or silent migration on first run. Recommended: warn + offer one-shot migration command.
8. **Friendly MCP server entry.** `kuzo serve` as a new bin in `@kuzo-mcp/cli`, or new `@kuzo-mcp/server` package with a `kuzo-mcp` bin, or document the `node <path>/server.js` invocation as canonical. Recommended: `kuzo serve` in the existing CLI binary — zero new packages, zero new install surfaces.
9. **GitHub App tokens in v1?** Recommended: deferred. PAT-only. Add a `--type` field to `credentials set` that's PAT-only in v1 but reserves the `app` value.
10. **Plugin `requiredCredentials` schema changes.** Already covered by existing `CredentialCapability`. Recommended: no schema changes — provisioning UX reads the existing manifest. Document this explicitly so the spec session doesn't re-invent.
11. **Multi-account support.** Two `GITHUB_TOKEN`s for personal vs work. Recommended: deferred. Single value per credential name in v1; spec a future `account: string` discriminant in the manifest if needed.
12. **Rotation flow.** `kuzo credentials rotate <name>` (alias for `set`) vs nothing (just re-run `set`). Recommended: alias for symmetry; one-line implementation.
13. **`KUZO_HOME` env override.** Land it in this phase. Default `~/.kuzo/`. Affects consent.json, audit.log, tuf-cache, plugins/, and any new credentials state. Recommended: yes, do it; opens the door for clean QA isolation.
14. **Audit entries on credential **write** (not just read).** Recommended: yes — `credential.set`, `credential.deleted`, `credential.rotated`. Cheap, high-signal, makes "did I rotate that?" an audit-log query.
15. **Broker scrub policy on plugin shutdown.** When a plugin unloads (shutdown hook), should its broker's scoped Map be zeroed? Recommended: yes; tiny memory hygiene win that costs nothing.
16. **Cross-platform secret store names.** macOS Keychain "service" + "account" naming convention. Spec the canonical `kuzo-mcp` service name + `<plugin>:<env-name>` account naming so entries are predictable + groupable.

---

## 6. Research targets — prior art the spec session reads first

Read all of these before drafting the spec. The recurring failure mode is "designed something then discovered `gh` already solved it differently for good reasons we missed."

- **`gh` (GitHub CLI):** `gh auth login` flow, how it stores tokens (`gh auth token` reads them back), platform-specific storage. Their headless story (`GH_TOKEN` env var override). Why they ship as a single signed Go binary.
- **`op` (1Password CLI):** secret injection model (`op run --`), session caching, why they avoid persisting secrets in config files.
- **`aws-vault`:** keyring abstraction (they use the same lib idea — stores tokens in OS keychain, retrieves on session creation). Their backend list (kwallet, secret-service, keychain, file).
- **`git-credential-osxkeychain` / `git-credential-libsecret`:** the simplest possible "credential helper" pattern. Stdin/stdout protocol. Worth knowing because `kuzo` could ship a `git-credential-kuzo` adapter as a side benefit.
- **`@napi-rs/keyring` source:** read the README, check the issue tracker for known macOS prompt issues, validate the SECURITY.md §6.5 claim about no-libsecret-on-Linux.
- **Deno permissions model:** `Deno.permissions.request("env")` as a finer-grained env-access primitive. Inspirational only — we don't have V8 isolates.
- **Chrome Extension MV3 `host_permissions` + `storage`:** the consent-flow shape we already follow comes from here. Their credential storage uses platform-keystore for managed enterprise extensions.
- **VSCode `SecretStorage` API:** how an Electron app exposes keychain to extensions. Closest analog to our plugin model.
- **Node 22+ `process.permission` (experimental):** worth knowing about, almost certainly not ready for our use case.
- **GitHub App auth flow:** JWT signing with installation private key, exchange for installation token, refresh logic. Skim only if Q9 lands on "in v1."
- **macOS code-signing for unsigned-Node:** `codesign --deep -s -` ad-hoc signing as a possible mitigation for Q2. Apple's documentation on keychain access groups + entitlements.

---

## 7. Deliverables expected from the spec session

Output: `docs/credentials-spec.md`. Shape modeled on `docs/2.5e-spec.md`. Implementation-ready: every section binding unless marked `[uncertain]`.

Required parts:

- **Part A — Storage backend.** Locked decision on Tier 1/2/4 mix. Library choice (Q1). macOS prompt strategy (Q2). Linux headless fallback (Q3). At-rest encryption policy (Q4).
- **Part B — Provisioning UX.** `kuzo credentials set/get/list/delete/rotate` command shapes. Inline-with-install integration (Q6). Migration from `~/.claude/settings.json` env block (Q7).
- **Part C — Broker upgrades.** `process.env` scrubbing (Q5). Lazy fetch. Third-party factory registration (Tier 3). Audit entries on writes (Q14). Shutdown scrub (Q15).
- **Part D — MCP server entry.** Friendly entry point (Q8). `~/.claude/settings.json` integration. Server boot sequence with credential lazy-load.
- **Part E — Directory contract.** `KUZO_HOME` env override (Q13). Migration of existing `~/.kuzo/` users. Service/account naming (Q16).
- **Part F — Acceptance + open questions + cutover.** End-to-end smoke tests (real keychain, real provisioning flow). Migration runbook for existing users. Open questions deferred to future phases.

Each part: research summary → option matrix with tradeoffs → recommended path with reasoning → implementation steps → gotchas.

Locked decisions table at the top (mirroring 2.5e §0). Numbered; spec session populates with answers to all questions in §5.

---

## 8. Anti-scope — explicitly NOT this phase

Naming these so the spec session doesn't drift.

- **Process isolation (`plugin-host.ts`, issue #26).** Natural follow-up. Out of scope here. Credential design should not block it but does not implement it.
- **Hosted deployment / Claude.ai connector.** Step 4 of the next-session plan, post-credentials.
- **AppleTV plugin.** Step 3 of the next-session plan, post-credentials.
- **OAuth-based plugin-to-third-party-API auth.** Plugins handle their own OAuth dances if they need them. The broker provides credentials, not OAuth flows.
- **Plugin signing beyond Sigstore.** Sigstore + Trusted Publishing is enough. Don't introduce a second signing scheme.
- **Plugin marketplace / discovery.** Locked-out per 2.5e §0 non-goals. Still locked-out.
- **Multi-tenant / shared-machine support.** Single-user assumption stays.
- **General-purpose secrets management.** This phase is "credentials for plugins." Not "Kuzo as a 1Password competitor."

---

## 9. Suggested phase naming

Don't lock this in the brief; let the spec session land on it after the research. Working title: **"Phase 2.6 — Credential Storage & Provisioning."** Alternative: **"Phase 3 prerequisite — Credential Lifecycle."** The spec session should put the chosen name in `docs/PLANNING.md` as part of the cutover plan.

---

## 10. How this lands in `STATE.md`

After this brief is committed, `docs/STATE.md` "Fresh-session handoff" gets rewritten to:

1. **Next session — credential research/spec session.** Read this brief. Read `docs/SECURITY.md` §6. Produce `docs/credentials-spec.md`. No code.
2. **After spec lands — credentials implementation phase.** Follow the spec's part-by-part build order.
3. **After credentials ship — real-life QA via Claude Code** (the original step 1, now properly enabled).
4. **After QA — AppleTV plugin** (was step 2).
5. **After AppleTV — hosted deployment + Claude.ai connector** (was step 3).
6. **After hosting — plugin expansion wave** (was step 4).

The QA step still happens; it just happens against a credentialed-properly install instead of one that's missing the entire provisioning surface.

---

## Appendix — pointers the spec session needs to know about

| Concern | File / location |
|---|---|
| Broker interface | `packages/types/src/index.ts:103-131` |
| `CredentialCapability` manifest type | `packages/types/src/index.ts:16-32` |
| Broker implementation | `packages/core/src/credentials.ts` |
| Config / dotenv loading | `packages/core/src/config.ts:33-49` |
| Consent storage | `packages/core/src/consent.ts:41-52` |
| Audit log shape | `packages/core/src/audit.ts` (action union) |
| Plugin install handler | `packages/cli/src/commands/plugins/install.ts` |
| Path constants | `packages/cli/src/commands/plugins/paths.ts` |
| Plugin host prototype | `packages/core/src/plugin-host.ts` (frozen — issue #26) |
| First-party plugin manifests (CredentialCapability examples) | `packages/plugin-{github,jira,git-context}/src/index.ts` |
| Pre-existing storage thinking | `docs/SECURITY.md` §6 |
| Spec-style template | `docs/2.5e-spec.md` (mirror this shape) |
| Current state of next-session plan | `docs/STATE.md` "Fresh-session handoff" section |

---

**Brief locked 2026-05-04.** Edits to the design space land in `docs/credentials-spec.md`, not here.
