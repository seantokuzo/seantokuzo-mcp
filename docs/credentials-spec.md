# Phase 2.6 — Credential Storage & Provisioning Spec

> Implementation north star for Kuzo MCP's credential lifecycle phase: encrypted-on-disk storage with OS-keychain key wrap, `kuzo credentials` CLI surface, `process.env` scrub, and a friendly `kuzo serve` entry point that decouples the MCP server from plaintext-on-disk secret blocks.

**Status:** Spec — not yet implemented. Every section below is binding unless marked `[uncertain]`.
**Source brief:** `docs/credentials-spec-brief.md` (locked 2026-05-04 after two rounds of review advisories).
**Predecessor research:** `docs/SECURITY.md` §6 (broker design — shipped in 2.5b/2.5c).
**Source research:** completed 2026-05-10 against current tool versions (`@napi-rs/keyring@1.3.0` exact-pin, Node 20+, Inquirer 9.x, Commander 12.x).
**Reference implementations cited:** `cli/cli` (gh), `microsoft/vscode` (SecretStorage + Electron safeStorage), `1Password/op` (app-integration), `Brooooooklyn/keyring-node`.

---

## Table of contents

- [0. Executive summary, locked decisions, build order](#0-executive-summary)
- [Part A — Storage backend](#part-a--storage-backend)
- [Part B — Provisioning UX](#part-b--provisioning-ux)
- [Part C — Broker upgrades](#part-c--broker-upgrades)
- [Part D — MCP server entry](#part-d--mcp-server-entry)
- [Part E — Directory contract](#part-e--directory-contract)
- [Part F — Acceptance, open questions, cutover](#part-f--acceptance-open-questions-cutover)
- [Appendix — reference implementations cited](#appendix--reference-implementations-cited)
- [Sources](#sources)

---

## 0. Executive summary

Phase 2.6 closes the credential-storage gap left open by `docs/SECURITY.md` §6 ("Phase 2.5d+ — `@napi-rs/keyring` or encrypted file"). The broker shipped in 2.5b/2.5c with `getClient` / `createAuthenticatedFetch` / `getRawCredential` / `hasCredential`. The storage behind it stayed plaintext-`process.env`-via-dotenv. This phase moves the storage to an **AES-256-GCM-encrypted blob on disk with a per-user AES key wrapped in the OS keychain (or scrypt-derived from a passphrase env var)** — and adds the provisioning UX, environment scrub, and entry point that walking the QA flow surfaced as missing.

The five load-bearing pieces:

1. **Part A (storage):** `~/.kuzo/credentials.enc` — single AES-256-GCM file containing all per-plugin credentials. Master key acquired via a swappable `KeyProvider`: `KeychainKeyProvider` (default; one keychain entry, one prompt per Node binary lifetime — VSCode pattern) or `PassphraseKeyProvider` (scrypt KDF over `KUZO_PASSPHRASE`, for Linux-headless / CI). Plain-env-per-credential override (`KUZO_TOKEN_<NAME>` and legacy `GITHUB_TOKEN` etc.) still works and bypasses the store entirely.
2. **Part B (provisioning):** `kuzo credentials set/list/delete/rotate/migrate/status` subcommands. Interactive echo-off prompt or explicit `--stdin`. One-shot `migrate` command that imports from `~/.claude/settings.json` env blocks and `.env` files, atomically rewrites the source with the value redacted, and read-back-verifies before zeroing in-memory copies.
3. **Part C (broker):** boot-time `process.env` scrub with pinned ordering (declared-env-names captured from static manifests → env scrubbed → plugins loaded; the first plugin needing a stored credential triggers a single keychain prompt during `loader.loadAll()` — parent-eager decrypt); third-party `getClient` factory registration on `PluginContext.credentials`; write-side audit events; `node:child_process` ESLint ban in pre-scrub paths.
4. **Part D (entry):** `kuzo serve` bin in `@kuzo-mcp/cli`. The canonical `~/.claude/settings.json` entry becomes `{ "command": "kuzo", "args": ["serve"], "env": {} }` — no secrets in the file.
5. **Part E (directory):** `KUZO_HOME` env override (default `~/.kuzo/`). Migration plan for existing users. Keychain `service=kuzo-mcp`, `account=master-key` naming convention.

The new threat-model win: **after Phase 2.6, the credential value never appears in `process.env` past server boot.** A signed-but-evil plugin loaded post-2.6 cannot read `process.env.GITHUB_TOKEN` directly because it's not there. Broker enforcement (already shipped) decides whether to hand the plugin a pre-auth client, a scoped fetch, or a raw value. That makes vector 2 of the brief — malicious plugins after Sigstore — defended for the first time.

### Locked decisions

Numbered against `docs/credentials-spec-brief.md` §5 open questions. Three substantive overrides of the brief's recommended defaults — all toward stronger security or better UX, justified by Task 1/3 research findings (see Appendix).

| # | Question | Decision | Override of brief default? |
|---|---|---|---|
| 1 | Primary keychain binding | `@napi-rs/keyring` pinned exactly to `1.3.0` (no `^`) behind a `KeyProvider` interface. Manual review on every bump (see A.9). No shell-out. | No |
| 2 | macOS prompt-storm mitigation | **VSCode-style hybrid**: single Keychain entry holds an AES-256 master key; encrypted blob on disk holds all credentials. One prompt per Node binary lifetime, not one per credential. | **YES — overrides "accept friction + docs"** |
| 3 | Linux headless / CI fallback | `KUZO_PASSPHRASE` env → scrypt-KDF → AES-256 master key. Per-credential plain-env override (`KUZO_TOKEN_<NAME>` / legacy names) also supported and bypasses the store. **No silent plain-env fallback inside the store** (mirrors `cli/cli#10108` lesson). | **YES — overrides "explicit `KUZO_CRED_BROKER=env` opt-in"** |
| 4 | At-rest encryption when keychain available | Hybrid is **primary**, not optional fallback. AES-256-GCM. Per-record nonce; format-version + KDF-id + KDF-params in AAD so tampering or backup-restore-with-stale-key fails closed. | **YES — overrides "Tier 1 only for v1"** |
| 5 | `process.env` scrub | Yes. Boot-ordering invariants pinned in `server.ts` code order. Kill-switch via `KUZO_NO_ENV_SCRUB=1` for dotenv-library-collision case (does NOT exempt `KUZO_PASSPHRASE`, which is always scrubbed). No `child_process.spawn/fork/exec/execFile/spawnSync/execSync/execFileSync` invocation between `ConfigManager` construction and the scrub — enforced by ESLint rule in `eslint.config.js` per §C.9. The `collectDeclaredCredentialEnvNames()` step reads `package.json#kuzoPlugin.capabilities` statically; it does NOT `import()` any plugin entry module before scrub. | No |
| 6 | Provisioning UX shape | Inline-after-`plugins install` prompt **plus** standalone `kuzo credentials set/list/delete/rotate/migrate/status`. **No `get`** (footgun-shaped — `list` shows what's set; `audit` shows what was read). Secret input: interactive echo-off prompt **or** explicit `--stdin` flag. No positional/flag value for the secret, ever. | Brief default + drop `get` |
| 7 | `~/.claude/settings.json` migration | `kuzo credentials migrate` — warns first, requires explicit confirm (or `--yes`). Atomic rewrite with the value redacted; **no `.bak` file**. Read-back-verify by byte-compare before rewriting the source. In-memory cleartext zeroed only after read-back passes (success) or after the failure-path audit-emit completes. | No |
| 8 | Friendly MCP server entry | `kuzo serve` bin in `@kuzo-mcp/cli`. Refactor existing `packages/core/src/server.ts` main into an exported `runServer({ scrub })` function. New canonical settings.json block has empty `env: {}`. | No |
| 9 | GitHub App tokens in v1 | Deferred. PAT-only. **The `--type` flag is dropped entirely from v1 (R44 nit)** — re-add when GitHub App support actually lands so we don't ship a flag that does nothing. | No |
| 10 | Plugin manifest schema changes | None. `CredentialCapability` is already the surface; provisioning reads it. | No |
| 11 | Multi-account support | Deferred. Single value per credential name. `account: string` discriminant deferred to a future phase. | No |
| 12 | Rotation flow | `kuzo credentials rotate <name>` — audit-distinct alias for `set`; emits `credential.rotated` instead of `credential.set`. | No |
| 13 | `KUZO_HOME` env override | Yes. Default `~/.kuzo/`. Precedence for plugins root: `KUZO_PLUGINS_DIR > KUZO_HOME/plugins > ~/.kuzo/plugins` (preserves 2.5e parity test). | No |
| 14 | Audit on credential writes | Yes. New `AuditAction` variants: `credential.set`, `credential.deleted`, `credential.rotated`, `credential.migrated`, `credential.migration_partial`, `credential.store_unlocked`, `credential.store_locked`, `credential.passphrase_consumed`, `credential.scrub_disabled`, `credential.wiped`, `credential.tested`, `audit.forged_plugin_field`. None record the value. Plugin-host audit emissions flow through IPC to the parent so the parent owns the writer (R16). | No |
| 15 | Shutdown scrub | Yes. **Parent**: `EncryptedCredentialStore.close()` clears the cache + `KeyProvider.wipeKeyCache?.()` zeros the master-key Buffer; wired in `server.ts` shutdown path **after** `loader.shutdownAll()` + `registry.shutdownAll()` per §C.1 invariant #4 (plugins may make final credential reads during shutdown). **Child**: each plugin's `DefaultCredentialBroker.shutdown()` clears its scoped Map; wired in `plugin-host.ts` after `plugin.shutdown()` per R25. Honest-zero-fill language per R13 — strings are dropped by reference; only Buffer overwrites are actual wipes. | No |
| 16 | Cross-platform secret store names | macOS Keychain / Linux Secret Service / Windows Credential Manager: `service="kuzo-mcp"`, `account="master-key"`. Single entry — the value is a base64-encoded AES-256 key, not a plugin credential. The encrypted blob is what holds individual credentials. | Refined — single entry not per-credential |

### Non-goals (explicitly out of 2.6)

- **Per-plugin process isolation upgrades** (issue #26 — plugin-host prototype freeze). Tracked separately. Credential design must not block it; this spec moves credentials out of `process.env`, which is exactly what the host-process model needs.
- **GitHub App auth flow** (JWT installation tokens). Deferred per Q9.
- **Multi-account support** ("personal + work GitHub"). Deferred per Q11.
- **OAuth flows for plugin-to-third-party-API auth.** Plugins handle their own OAuth dances; the broker provides credentials, not OAuth orchestration.
- **General-purpose secrets management.** This is "credentials for plugins," not "Kuzo as a 1Password competitor." `kuzo credentials` is scoped to plugin credentials only.
- **Plugin marketplace / discovery.** Locked-out per 2.5e §0; still locked-out.
- **Multi-tenant / shared-machine support.** Single-user assumption stays.
- **Encrypted audit log.** Audit log stays plaintext JSON lines (entries already redact values). Encrypting it is post-2.6 if needed.
- **Shell completion (R43).** Bash / zsh / fish completion for `kuzo credentials *` and `kuzo plugins *` is deferred to a future phase. Commander's completion plumbing is available but adding it cleanly across all three shells requires its own design pass + per-shell smoke tests. Not part of 2.6.

### Cross-cutting build order

The six parts have dependencies. Recommended order — each numbered group is one or more atomic commits on `phase-2.6/credentials`:

1. **E.1–E.2: `KUZO_HOME` + shared `packages/core/src/paths.ts`** — refactor existing path helpers; consent.ts and audit.ts pick up new helpers. Zero behavior change.
2. **A.1–A.4: Storage primitives** — cipher, key providers (keychain + passphrase), `CredentialStore` interface, `EncryptedCredentialStore` impl. Unit tests against tmpdir + an `InMemoryKeyProvider` test double.
3. **A.5–A.6: CredentialSource + env-override collection** — bridges store + env. Pure logic, easy to test.
4. **C.1–C.3 + C.9: Boot sequence rewrite + child_process lint rule** — refactor `server.ts` `main()` → exported `runServer()` (keep the self-invocation guard at file bottom for `node server.js` + parity test); insert credential-source build + scrub before `loader.loadAll()`; `loader.ts` swaps `configManager.extractPluginConfig` → `credentialSource.extractForPlugin`; add the `node:child_process` ESLint ban to `eslint.config.js` scoped to `server.ts` + `loader.ts`. Existing parity test must stay green; a new boot-sequence smoke proves scrub happens before any plugin init AND `process.env.GITHUB_TOKEN === undefined` inside a freshly-forked plugin child.
5. **C.10: Plugin-host audit emissions over IPC** — re-route `plugin-host.ts` writes through the parent's IPC channel; parent stamps PID + validates the `plugin` field against the child's declared identity; forgery attempts logged as `audit.forged_plugin_field`. MUST land BEFORE any of the §B.7 write-side audit events (`credential.set` / `.rotated` / `.migrated` / `.wiped` / `.tested`) go live — every new event compounds the impersonation surface.
6. **C.4–C.6: Broker write-side audit events + shutdown hooks** — add `credential.set` etc. to `AuditAction` union; wire shutdown scrub via `wipeKeyCache`.
7. **B.1–B.3 + A.11: `kuzo credentials set/list/delete/rotate/status/test/wipe`** — new command tree under `packages/cli/src/commands/credentials/`. Inquirer prompts; no flag/arg value for secrets. State machine from §A.11 wired into `set`/`rotate` (refuse KEY_LOST + CORRUPTED states with explicit exits 72/73). Lock file shared with `kuzo plugins` (single `~/.kuzo/.lock` for any write to the kuzo home — see E.2).
8. **B.4: `kuzo credentials migrate`** — settings.json + .env import with atomic rewrite + read-back-verify. Symlink-safe, snapshot-compare, bounded `.env` walk per §B.4 hardening (R18–R23). Most footgun-rich command; ship it last and gate behind explicit confirm.
9. **D.1–D.3 + C.11: `kuzo serve` bin + rotation cache invalidation** — wraps `runServer()`. Update `packages/cli/package.json` bin entry. Wire `fs.watch(credentialsFilePath)` + IPC `credential.refresh` notifications to running plugin children (R34). Add upgrade-detection banner (R35) at server-ready time. Verify via Claude Code's MCP settings.json after install of `@kuzo-mcp/cli@0.1.0`.
10. **F: Docs + canary** — update `SECURITY.md` §6, `PLANNING.md`, `STATE.md`, `README.md` (per §F.3 step 9 outline). Cut a coordinated release for all 6 packages (`@kuzo-mcp/types` may stay at 0.0.1 if no contract changes; core + cli + plugins bump to 0.1.0 for first credentialed release).

Per-step build-greenness: `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test:parity` must remain clean. New tests under `packages/core/src/credentials/*.test.ts` (vitest if it lands during this phase, else node:test) and `packages/cli/src/commands/credentials/*.test.ts`.

---

## Part A — Storage backend

> Move plugin credentials from `process.env`-via-dotenv into an AES-256-GCM-encrypted blob on disk with a per-user master key wrapped by the OS keychain (or KDF-derived from a passphrase env var on headless boxes).

### A.0 Scope

**In:** cryptographic primitives (cipher, KDF), file format, `CredentialStore` interface + default impl, swappable `KeyProvider`, one-shot migration from `process.env` / `.env`, audit events on read/write, dependency policy for `@napi-rs/keyring`.

**Out:** provisioning CLI (Part B), broker boot-integration (Part C), server entry point (Part D), KUZO_HOME plumbing (Part E).

### A.1 Tier choice — the VSCode pattern as primary

**Why the brief's recommended default (Tier 1 only, accept macOS prompts) is wrong.** Research Task 3 (`docs/credentials-spec-brief.md` Appendix) shows that on macOS, an unsigned Node binary's Keychain ACL identity is "absolute path + binary hash." `nvm`, `Volta`, and `asdf` all swap the active Node binary at a versioned path per install, so every Node version bump produces a fresh ACL identity and a fresh prompt for **every** credential entry. With per-credential entries (Tier 1) and 5–10 credentials across plugins, a `volta install node@latest` becomes 5–10 prompts on next server start. That's the user-experience cliff that pushes people to `KUZO_NO_ENV_SCRUB=1` and reverts the security gain.

VSCode solved this years ago: store **one** symmetric key in the keychain, encrypt **everything else** in a file with that key. One keychain prompt per Node binary lifetime regardless of credential count. The threat model is unchanged: an attacker who can call Keychain Services as the user can extract the master key and decrypt the blob — but the same attacker against Tier 1 can call Keychain Services per-entry and extract everything anyway. We're not buying weaker security; we're paying once.

This is what `Electron.safeStorage` does (`microsoft/vscode` uses it as its `SecretStorage` backend). 1Password's `op` CLI goes further with a daemon, but that's overkill for v1.

**Decision:** the encrypted-blob design is the **primary** storage path on every platform. Per-platform variation lives entirely in `KeyProvider` (how the master key is acquired). The blob format and the store API are identical everywhere.

Tier 4 (external secret managers like `op run -- kuzo serve`) is supported via the per-credential env-var override path — no special mode flag needed (see A.5).

### A.2 Cryptographic primitives

**Cipher:** AES-256-GCM. Node built-in `crypto.createCipheriv("aes-256-gcm", key, nonce)` — zero new deps, well-audited path. AES-256-GCM is the default for hardware-accelerated platforms (AES-NI on x86-64 + ARMv8 crypto extensions cover every macOS, Windows-on-x64, Apple Silicon, and modern x86-64 Linux box we care about). On platforms without AES-NI (legacy ARM, some embedded boards), AES-GCM falls back to a software implementation and is ~3× slower than ChaCha20-Poly1305. The blob is small (< 1 KB typical) — the difference is sub-millisecond. AES-GCM stays the default; ChaCha20-Poly1305 is a non-goal for v1.

**Nonce:** 96-bit random per encryption (`crypto.randomBytes(12)`). Stored in the file header.

**AEAD additional data (AAD):** the file header (magic + version + KDF id + KDF params block) PLUS the keychain-entry generation counter (see §A.3). Tampering with the header (version flip, KDF downgrade, salt swap) OR rolling the file back to a stale generation (backup-rollback attack) breaks decryption with a `BAD_DECRYPT` error.

**KDF (passphrase mode only):** `crypto.scryptSync(passphrase, salt, 32, { N: 2**17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 })`. `N=2^17` (~130k iterations) is the OWASP 2023 recommendation; ~100ms cost on a 2024 laptop. The empirical memory required is ~128 MiB (`128 * r * N` bytes for scrypt's working set); the spec sets `maxmem` to 256 MiB to leave comfortable slack. **Lower values throw at runtime** — Node's 32-MiB default and the round-2 spec's claimed-as-verified 64-MiB both fail with `Invalid scrypt params: memory limit exceeded`. Salt is 16 bytes random, stored in the KDF params block of the file header.

**Master key:** 32 bytes (AES-256). Either:
- **Keychain mode**: stored as a JSON blob `{key: <base64-32-bytes>, generation: <integer>}` at `service="kuzo-mcp" account="master-key"` via `@napi-rs/keyring`. `generation` starts at 1 on `initializeKey()` and bumps on every successful write (`set` / `rotate` / `delete` / `migrate`); the file's AAD includes the current generation, so a rolled-back file (whose AAD-embedded generation is < the live keychain generation) fails GCM verification. Both the key and the generation live in a single keychain entry — `@napi-rs/keyring` doesn't expose enumeration, and a single JSON value is cheaper than two entries to keep in sync.
- **Passphrase mode**: derived from `process.env.KUZO_PASSPHRASE` via the scrypt KDF over the salt in the file header. Passphrase never touches disk; salt does. The generation counter is stored in `~/.kuzo/credentials.generation` (a small 0600 file containing a base-10 integer) — passphrase mode has no keychain entry to hold it. The same AAD-binding rules apply: file's AAD includes the generation, mismatch fails decrypt.

### A.3 File format — `~/.kuzo/credentials.enc`

```
Offset    Size   Field
──────────────────────────────────────────────────────────────────
0         4      Magic bytes:         "KCR1" (0x4B 0x43 0x52 0x31)
4         1      Format version:      0x01
5         1      KDF id:              0x00 = keychain (no KDF), 0x01 = scrypt
6         ?      KDF params block:    16-byte salt if scrypt; empty if keychain
6 + p     8      Generation counter:  big-endian uint64
──────────────────────────────────────────────────────────────────  ← AAD ends here
6 + p+8   12     Nonce                (96-bit random per encryption)
6 + p+20  N      Ciphertext           (AES-256-GCM output)
end-16    16     Tag                  (GCM tag)
```

`p` is 0 for keychain mode, 16 for passphrase mode. The AAD covers bytes 0 through `5 + p + 8` (header + generation). Any header tamper (version flip, KDF downgrade, salt swap) OR a generation mismatch (file rolled back to a stale snapshot whose embedded generation is older than the live counter in the keychain entry / `credentials.generation` file) fails decrypt.

**Generation counter semantics (R12).** Defeats the backup-rollback attack class:
1. Attacker (FS-write malware OR a manual Time Machine restore) replaces the live `credentials.enc` with an older snapshot before the user rotated a credential.
2. The static AAD (magic, version, KDF id, salt) matches because the header layout is stable.
3. Without a generation counter, GCM verification succeeds → user thinks they rotated, attacker still has the old (long-lived) token.
4. With the generation counter: the old file's AAD embeds generation `G_old`, the live keychain (or `.generation` file) says `G_new > G_old`. AAD assembled from live state ≠ AAD that signed the file. GCM verification fails. User sees `E_FILE_CORRUPTED` (exit 73) and is forced to `wipe + re-provision` instead of silently rolling back.
5. Tradeoff: a **legitimate** Time Machine restore (user rebuilt their Mac and restored from backup) ALSO fails decrypt if the keychain restore lags behind the file restore. The user must run `kuzo credentials wipe --confirm` and re-provision credentials. We choose rollback-attack-resistance over backup-restore-cheapness. Documented in §F.4 risks.

**Header immutability rule (R15).** Any change to the header byte layout — including adding a single byte between magic and ciphertext — invalidates all existing files (AAD bytes change → GCM verification fails). Header changes MUST bump magic to `KCR2`+ and ship a migration that reads `KCR1` → re-encrypts as `KCR2`. The migration handler decrypts using the old layout, then re-encrypts using the new layout with `generation := current_generation + 1` (so the migration itself counts as a write event and a rolled-back pre-migration file is rejected post-migration).

**Payload forward-compat (R15).** The plaintext JSON payload, by contrast, is forward-compatible: new fields are ignored by old readers; missing fields are treated as defaults. This is the only safe place to add metadata without a magic bump — for example, future per-credential `lastVerifiedAt` timestamps from `kuzo credentials test` would be additive JSON fields.

**Plaintext payload** is UTF-8 JSON:

```json
{
  "version": 1,
  "credentials": {
    "GITHUB_TOKEN": "ghp_...",
    "GITHUB_USERNAME": "seantokuzo",
    "JIRA_HOST": "kuzo.atlassian.net",
    "JIRA_EMAIL": "...",
    "JIRA_API_TOKEN": "..."
  },
  "createdAt": "2026-05-20T10:00:00.000Z",
  "lastUpdated": "2026-05-20T10:00:00.000Z"
}
```

**Write path** (`set` / `rotate` / `delete` / `migrate`):
1. Acquire master key via `KeyProvider.acquireKey()` (may prompt or KDF).
2. Read current generation counter from the source of truth (keychain entry's JSON value for keychain mode, `~/.kuzo/credentials.generation` for passphrase mode).
3. Decrypt existing file into plaintext map (or start with `{}` if absent). On decrypt, verify the file's embedded generation matches the current counter; mismatch → `E_FILE_CORRUPTED` (exit 73).
4. Apply mutation to the map.
5. Update `lastUpdated`.
6. Bump generation `G := G + 1`.
7. Generate fresh 12-byte nonce.
8. Assemble AAD from header bytes 0..5+p plus the new generation (8-byte big-endian).
9. Encrypt with the master key + nonce + AAD.
10. Persist the new generation BEFORE writing the file: update the keychain entry (`{key, generation: G}`) OR write `~/.kuzo/credentials.generation.tmp` + fsync + rename. Generation-persists-first is critical — if the process crashes between step 10 and step 11, the next boot sees `G_live > G_file` and refuses to decrypt the file (treats it as rolled-back), forcing recovery via `wipe`. Reverse order (file first, generation second) would leave the file decryptable but rejected on next read; the conservative ordering treats the file as the authoritative "committed state" and the generation as the persistence barrier.
11. Write to `~/.kuzo/credentials.enc.tmp`; `fsync`; `rename` to `~/.kuzo/credentials.enc`. Atomic on POSIX, atomic-ish on Windows (NTFS `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`).
12. Audit-emit `credential.set` / `.rotated` / `.deleted` / `.migrated` with key name + new generation — never the value.

**Read path** (broker `get` and `runServer()` boot):
1. Acquire master key (cached after first call within process lifetime).
2. Read live generation counter.
3. Decrypt file once on first read; cache plaintext map in `EncryptedCredentialStore` instance. If the file's embedded generation < live counter → `E_FILE_CORRUPTED` (exit 73), prompts the user to `wipe + re-provision`.
4. Return value by key.

**File mode:** `0600` on POSIX (`chmod` after rename). On Windows, use `fs.chmod` (NTFS interprets it via ACL inheritance — sufficient for our threat model; full ACL hardening is post-v1).

### A.4 `CredentialStore` interface

New file `packages/core/src/credentials/store.ts`:

```typescript
/**
 * Persistent storage for plugin credentials.
 * Backed by AES-256-GCM on disk with a master key from a swappable KeyProvider.
 */
export interface CredentialStore {
  /** Get a credential value (cleartext). Lazy-decrypts on first call. */
  get(key: string): string | undefined;

  /** Set a credential value. Persists immediately. Emits `credential.set` audit. */
  set(key: string, value: string): void;

  /** Delete a credential. Returns true if it was present. Emits `credential.deleted`. */
  delete(key: string): boolean;

  /** Names of currently-set credentials. Never returns values. */
  list(): string[];

  /** Whether a key is present, without RE-decrypting; requires at least one prior `get()` or `reload()` to have populated the cache. Returns `false` on a never-unlocked store. */
  has(key: string): boolean;

  /** Force a fresh load from disk (e.g. after external edit by the user). */
  reload(): void;

  /**
   * Zero the in-memory cleartext map. Called on server shutdown.
   * After close(), get/has return undefined/false until reload() is called.
   */
  close(): void;

  /** Backend identity for status output ("keychain" | "passphrase" | "memory"). */
  readonly backend: string;
}
```

Default implementation `EncryptedCredentialStore` in the same file. Constructor takes `{ filePath, keyProvider, auditLogger?, logger? }`.

### A.5 `KeyProvider` interface

New file `packages/core/src/credentials/key-provider.ts`:

```typescript
/**
 * Acquires the AES-256 master key used to encrypt the credential blob.
 * Implementations vary by platform / mode (keychain vs passphrase).
 */
export interface KeyProvider {
  /** Backend identity ("keychain" | "passphrase" | "memory"). */
  readonly id: string;

  /**
   * Acquire the master key. May prompt the user (keychain on macOS first run)
   * or run a KDF (passphrase). Returns a 32-byte Buffer.
   *
   * Implementations cache the key internally after first call.
   */
  acquireKey(headerKdfParams: Buffer): Buffer;

  /**
   * Generate a fresh master key and persist it (keychain) or capture salt
   * (passphrase). Called when the credential file does not yet exist.
   * Returns the new key + the header KDF params to write.
   */
  initializeKey(): { key: Buffer; kdfParams: Buffer };

  /**
   * KDF id byte to write into the file header.
   * 0x00 = keychain (no KDF), 0x01 = scrypt.
   */
  readonly kdfId: number;
}
```

Implementations:

**`KeychainKeyProvider`** — uses `@napi-rs/keyring`:

```typescript
import { Entry } from "@napi-rs/keyring";

export class KeychainKeyProvider implements KeyProvider {
  readonly id = "keychain";
  readonly kdfId = 0x00;
  private cached: Buffer | undefined;
  private readonly entry: Entry;

  constructor(opts: { service?: string; account?: string } = {}) {
    this.entry = new Entry(
      opts.service ?? "kuzo-mcp",
      opts.account ?? "master-key",
    );
  }

  acquireKey(): Buffer {
    if (this.cached) return this.cached;
    const stored = this.entry.getPassword();
    if (!stored) {
      throw new KeyProviderError(
        "No master key in keychain. Run `kuzo credentials set <name>` to initialize.",
      );
    }
    this.cached = Buffer.from(stored, "base64");
    if (this.cached.length !== 32) {
      throw new KeyProviderError(
        `Keychain master key is ${this.cached.length} bytes; expected 32. Manual tamper?`,
      );
    }
    return this.cached;
  }

  initializeKey(): { key: Buffer; kdfParams: Buffer } {
    const key = randomBytes(32);
    this.entry.setPassword(key.toString("base64"));
    this.cached = key;
    return { key, kdfParams: Buffer.alloc(0) };
  }
}
```

**`PassphraseKeyProvider`** — scrypt-derived:

```typescript
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

export class PassphraseKeyProvider implements KeyProvider {
  readonly id = "passphrase";
  readonly kdfId = 0x01;
  private cached: Buffer | undefined;
  // Mutable, populated by constructor, overwritten to undefined after the first
  // successful acquireKey/initializeKey. After that point, re-deriving the key
  // (e.g. for a future rotate-and-re-encrypt path) is impossible without
  // re-prompting the user — by design.
  private passphrase: string | undefined;

  constructor(
    passphrase: string,
    private readonly auditLogger?: AuditLogger,
  ) {
    if (!passphrase) {
      throw new KeyProviderError(
        "KUZO_PASSPHRASE is empty — refusing to derive a key from empty string.",
      );
    }
    this.passphrase = passphrase;
  }

  acquireKey(headerKdfParams: Buffer): Buffer {
    if (this.cached) return this.cached;
    if (!this.passphrase) {
      throw new KeyProviderError(
        "PassphraseKeyProvider passphrase has been consumed; restart the server to re-enter.",
      );
    }
    if (headerKdfParams.length !== 16) {
      throw new KeyProviderError(
        `Expected 16-byte salt in header; got ${headerKdfParams.length}`,
      );
    }
    const saltFp = createHash("sha256").update(headerKdfParams).digest("hex").slice(0, 16);
    this.cached = scryptSync(this.passphrase, headerKdfParams, 32, SCRYPT_PARAMS);
    this.consumePassphrase();
    this.auditLogger?.log({
      plugin: "kuzo",
      action: "credential.passphrase_consumed",
      outcome: "allowed",
      details: { provider: "passphrase", salt_fingerprint: saltFp },
    });
    return this.cached;
  }

  initializeKey(): { key: Buffer; kdfParams: Buffer } {
    if (!this.passphrase) {
      throw new KeyProviderError(
        "PassphraseKeyProvider passphrase has been consumed; restart the server to re-enter.",
      );
    }
    const salt = randomBytes(16);
    const key = scryptSync(this.passphrase, salt, 32, SCRYPT_PARAMS);
    this.cached = key;
    this.consumePassphrase();
    return { key, kdfParams: salt };
  }

  // Hygiene-best-effort: overwrite the stashed passphrase field and drop the
  // reference. V8 string interning may leave the original UTF-16 buffer in heap
  // until GC — documented as best-effort, not a tamper-evidence guarantee. The
  // real defense is the unconditional process.env scrub in server.ts step 7
  // plus the dead-by-default semantics of the field after this method runs.
  private consumePassphrase(): void {
    if (this.passphrase) {
      const len = this.passphrase.length;
      this.passphrase = "\0".repeat(len);
    }
    this.passphrase = undefined;
  }
}
```

**Scrypt memory accounting (R11).** The empirical memory required by `N=2^17 r=8 p=1` is approximately 128 MiB (`128 * r * N` bytes for the hashing buffer + working set). Node's default `maxmem` (32 MiB) and the round-2 spec's claimed-as-verified `64 MiB` both throw `Invalid scrypt params: memory limit exceeded` at runtime. The correct value is `256 * 1024 * 1024` (256 MiB) — comfortable slack above the 128 MiB requirement, well below typical process limits. Hoisted into the `SCRYPT_PARAMS` constant so `acquireKey` and `initializeKey` share one source of truth.

**Passphrase scrubbing (R7).** `KUZO_PASSPHRASE` is unconditionally scrubbed from `process.env` at boot step 7 (regardless of the `--no-scrub` kill-switch). The provider's `passphrase` field is overwritten + dropped on first successful derivation via `consumePassphrase()`. There is no escape hatch (no `KUZO_KEEP_PASSPHRASE=1`) — re-derivation requires a server restart with the passphrase set again. Argues for the keychain path on macOS over passphrase-based long-running servers.

**`credential.passphrase_consumed` audit event (R8).** Emitted after the scrypt derivation completes. Details include `salt_fingerprint` = sha256 of the salt truncated to 16 hex chars (so the user can detect "did MY salt get consumed" vs "did an attacker swap the file with their salt") — NEVER the passphrase itself.

**`InMemoryKeyProvider`** — test double only. Throws if instantiated outside `NODE_ENV=test` / `KUZO_TEST=1`. Used by `EncryptedCredentialStore` unit tests so we don't need a real keychain in CI.

**`NullKeyProvider`** — env-override-only sentinel for headless / CI runs that ship every credential via `process.env` and never touch the encrypted store. Selected when `KUZO_DISABLE_KEYCHAIN=1` is set AND `KUZO_PASSPHRASE` is unset.

```typescript
export class NullKeyProvider implements KeyProvider {
  readonly id = "null";
  readonly kdfId = 0xff;

  acquireKey(): never {
    throw new KeyProviderError(
      "E_NO_STORAGE: credential storage is disabled (KUZO_DISABLE_KEYCHAIN=1 without KUZO_PASSPHRASE)",
    );
  }

  initializeKey(): never {
    throw new KeyProviderError(
      "E_NO_STORAGE: credential storage is disabled (KUZO_DISABLE_KEYCHAIN=1 without KUZO_PASSPHRASE)",
    );
  }
}
```

`EncryptedCredentialStore.get()` MUST short-circuit to `undefined` (without calling `acquireKey()`) when the credential file does not exist. In env-override-only mode the file never exists, so the short-circuit fires for every lookup, `CredentialSource` falls back to env overrides, and `NullKeyProvider.acquireKey()` is never invoked. The throw is a defense-in-depth guard against future code paths that accidentally bypass the file-existence check.

**Constructor side-effect freedom invariant.** `new KeychainKeyProvider()`, `new PassphraseKeyProvider(passphrase)`, `new InMemoryKeyProvider()`, and `new NullKeyProvider()` perform NO I/O, NO dbus calls, NO Keychain Services calls. They allocate fields only. Only `acquireKey()` / `initializeKey()` may invoke external systems. Rationale: `chooseKeyProvider()` runs at boot step 4 — before the step 7 `process.env` scrub. On Linux, the `@napi-rs/keyring` `Entry` constructor can touch dbus; on macOS it can talk to Keychain Services. A construction-time side effect that reads `process.env` (e.g., a dbus library that respects `DBUS_SESSION_BUS_ADDRESS`) inside a pre-scrub child fork would void the scrub guarantee. Keep constructors strictly inert; the `Entry` object referenced by `KeychainKeyProvider.entry` is lazily-bound — first I/O happens in `acquireKey()` after the scrub completes.

**Selection logic** (in `server.ts` boot):

```typescript
function chooseKeyProvider(auditLogger: AuditLogger): KeyProvider {
  if (process.env.KUZO_DISABLE_KEYCHAIN === "1") {
    if (process.env.KUZO_PASSPHRASE) {
      return new PassphraseKeyProvider(process.env.KUZO_PASSPHRASE, auditLogger);
    }
    // env-override-only mode: no encrypted store backing.
    // EncryptedCredentialStore.get() will short-circuit to undefined when
    // credentials.enc does not exist; CredentialSource falls back to env overrides.
    return new NullKeyProvider();
  }
  if (process.env.KUZO_PASSPHRASE) {
    // Explicit passphrase opt-in even when keychain is available
    return new PassphraseKeyProvider(process.env.KUZO_PASSPHRASE, auditLogger);
  }
  return new KeychainKeyProvider();
}
```

Precedence:
1. `KUZO_DISABLE_KEYCHAIN=1` + `KUZO_PASSPHRASE` set → `PassphraseKeyProvider` (passphrase mode on platforms with broken/missing keychain libs).
2. `KUZO_DISABLE_KEYCHAIN=1` + `KUZO_PASSPHRASE` unset → `NullKeyProvider` (env-override-only mode, recommended for ephemeral CI with per-credential secret injection).
3. `KUZO_PASSPHRASE` set (without `KUZO_DISABLE_KEYCHAIN`) → `PassphraseKeyProvider` (explicit passphrase opt-in even when keychain is available).
4. Otherwise → `KeychainKeyProvider`.

No silent plain-env fallback (`cli/cli#10108` lesson) — the only "use env only" path is the explicit `KUZO_DISABLE_KEYCHAIN=1` opt-in, which yields a `NullKeyProvider` that fails closed if anything tries to access the encrypted store.

### A.6 `CredentialSource` — env override + store merge

New file `packages/core/src/credentials/source.ts`:

```typescript
/**
 * Lookup credentials by env-var name, with env-override precedence over store.
 * Used by the loader to build the per-plugin scoped credential Map handed
 * to DefaultCredentialBroker (the broker interface itself is unchanged).
 */
export class CredentialSource {
  constructor(
    private readonly store: CredentialStore,
    private readonly envOverrides: Record<string, string>,
  ) {}

  /** Get a value: env override wins, then store, then undefined. */
  get(key: string): string | undefined {
    if (Object.hasOwn(this.envOverrides, key)) return this.envOverrides[key];
    return this.store.get(key);
  }

  /** Whether the key has a value from any source. */
  has(key: string): boolean {
    return Object.hasOwn(this.envOverrides, key) || this.store.has(key);
  }

  /**
   * Extract credential values for a plugin from its declared capabilities.
   *
   * Caller passes a single combined list — both required capabilities (from
   * `plugin.capabilities.filter(kind === "credentials")`) and optional ones
   * (from `plugin.optionalCapabilities`). Each `CredentialCapability` carries
   * an `optional?: boolean` field; only caps with `optional !== true` contribute
   * to the returned `missing` array. Optional caps that are absent are silently
   * omitted from `config` — the plugin sees `undefined` when it asks for them
   * via `config.get(...)`.
   */
  extractForPlugin(
    caps: readonly CredentialCapability[],
  ): { config: Map<string, string>; missing: string[] } {
    const config = new Map<string, string>();
    const missing: string[] = [];
    for (const cap of caps) {
      const value = this.get(cap.env);
      if (value !== undefined) {
        config.set(cap.env, value);
      } else if (!cap.optional) {
        missing.push(cap.env);
      }
      // optional + missing: silent omission, plugin handles undefined itself.
    }
    return { config, missing };
  }
}
```

`extractForPlugin` is the drop-in replacement for `ConfigManager.extractPluginConfig`. Same return shape (`config` Map + `missing` string array), so `loader.ts` change is one line:

```typescript
// Before
({ config, missing } = this.configManager.extractPluginConfig(v2Config.required, v2Config.optional));

// After
({ config, missing } = this.credentialSource.extractForPlugin([
  ...plugin.capabilities.filter(c => c.kind === "credentials") as CredentialCapability[],
  ...(plugin.optionalCapabilities ?? []).filter(c => c.kind === "credentials") as CredentialCapability[],
]));
```

(Optional capabilities are extracted but never appear in `missing`.)

### A.7 Env-override collection

New file `packages/core/src/credentials/env-overrides.ts`:

```typescript
/**
 * Collect credential values supplied via process.env.
 * Two supported patterns:
 *   - Legacy plain names: GITHUB_TOKEN, JIRA_API_TOKEN, etc. (the names plugins declare in their CredentialCapability.env)
 *   - Explicit kuzo-namespace override: KUZO_TOKEN_<NAME> (gh-style, future-proof)
 *
 * Both are valid; KUZO_TOKEN_<NAME> wins if both are set (more explicit).
 */
export function collectEnvOverrides(
  declaredEnvNames: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {};

  // Plain declared names
  for (const name of declaredEnvNames) {
    const v = process.env[name];
    if (v) out[name] = v;
  }

  // KUZO_TOKEN_<NAME> pattern — overrides plain
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("KUZO_TOKEN_") && v) {
      const target = k.slice("KUZO_TOKEN_".length);
      out[target] = v;
    }
  }

  return out;
}

/**
 * Delete the matched keys from process.env so plugins loaded later
 * (or their child processes) cannot read them directly.
 *
 * No-ops when KUZO_NO_ENV_SCRUB=1 (kill-switch). The kill-switch does NOT
 * exempt KUZO_PASSPHRASE, which is unconditionally scrubbed regardless.
 */
const ALWAYS_SCRUB = ["KUZO_PASSPHRASE"] as const;

export function scrubProcessEnv(scrubKeys: readonly string[]): void {
  const killSwitch = process.env.KUZO_NO_ENV_SCRUB === "1";
  const targets = killSwitch
    ? new Set(ALWAYS_SCRUB)
    : new Set([...scrubKeys, ...ALWAYS_SCRUB]);
  for (const key of targets) {
    delete process.env[key];
    delete process.env[`KUZO_TOKEN_${key}`];
  }
}
```

`declaredEnvNames` is built at boot from the union of all `CredentialCapability.env` values across all enabled plugin manifests. The names come from **`package.json#kuzoPlugin.capabilities`** read synchronously off disk — no plugin entry module is `import()`-ed before scrub completes (see §C.1 invariant 6 + §C.9 lint rule). The list is a small synchronous walk; cost is `O(plugin_count * fs.readFile + JSON.parse)` and lives entirely in the parent process.

### A.8 Migration from `.env` (one-time on `kuzo credentials migrate`)

`process.env` still gets populated from `.env` at boot by `ConfigManager.loadDotenv()` (existing). That stays — `.env` is also where users keep non-secret config like `LOG_LEVEL`. The migration command is what removes the **credential** entries from `.env` and the settings.json env block; the dotenv load itself doesn't change.

Migration flow detail is in Part B §B.4.

### A.9 Dependency policy — tiered (R14)

Per the brief's §2 vector 7, third-party credential code has total blast radius. But the threat surface isn't uniform across "every package that touches a secret" — a native binding mediating every keychain read is structurally different from a JS-only CLI helper. Tier dependencies by what they actually do:

| Tier | Packages (and what they do) | Policy |
|---|---|---|
| **1 — Credential-mediating native binding** | `@napi-rs/keyring` — Rust binary loaded into every kuzo-mcp process, mediates every read of the master key | Exact pin (no `^`). Manual review per bump. Verify the napi prebuilt binary checksum against the GitHub release asset before merge. |
| **2 — Secret-touching, JS-only** | `inquirer` (password prompt), `commander` (flag parsing), `dotenv` (loads `.env`) | Caret-range pin (`^X.Y.Z`). Dependabot enabled; bumps land in their own PR with CHANGELOG diff. NOT manual review per release. |
| **3 — Standard runtime deps** | `pacote`, `sigstore`, `signal-exit`, `@modelcontextprotocol/sdk`, every other dep | Caret-range. Dependabot auto-merge on green CI for patch bumps; minor+major in their own PR. |

**Why the tiering.** Tier 1 is structurally privileged: a native binding can do anything the Node process can do, and JS-level review of source-as-published-on-npm doesn't see the Rust source compiled into the prebuilt. Pinning exact + checksumming the binary is the only meaningful defense. Tiers 2 and 3 are auditable JS — the dependency's package contents are readable in `node_modules`, and a malicious bump would be visible in a PR diff. Conflating "secret-touching" with "secret-mediating-via-native-binding" creates dependency-bump pain that doesn't pay off in security.

**Tier 1 enforcement (`@napi-rs/keyring`):**
1. **Pin exact.** `"@napi-rs/keyring": "1.3.0"` in `packages/core/package.json` (no `^`). Same posture as `pacote`/`sigstore` in 2.5e for analogous reasons.
2. **Manual review on every bump.** `pnpm update @napi-rs/keyring` must be its own PR. Diff the package's CHANGELOG and the GitHub release notes; eyeball any new transitive deps.
3. **Checksum the prebuilt binary.** On bump, download the `@napi-rs/keyring-<platform>` prebuilt from the GitHub release for the new version and verify SHA-256 against what npm shipped. Document the verified hashes in the bump PR.
4. **No transitive auto-bumps.** `pnpm-lock.yaml` is the source of truth. CI checks lockfile cleanliness.
5. **No alternative bindings shipped in parallel.** One binding, one Rust transitive surface. Adding `node-keytar` as a fallback would double the attack surface for no UX gain.
6. **Adapter wraps it.** `KeychainKeyProvider` is the only file that imports `@napi-rs/keyring`. The rest of the codebase imports `KeyProvider`. Swap-out cost is one file if a future advisory forces it.

**Tier 2 enforcement (`inquirer`/`commander`/`dotenv`):**
1. Caret-range pin (`^X.Y.Z`) in the relevant package.json.
2. Dependabot enabled for the repo (already on).
3. Each bump PR gets a CHANGELOG diff in the description. No manual review per release — the auditability of JS source covers it.
4. Major-version bumps reviewed as their own dedicated PR with a regression check (does the password-prompt still actually echo-off? does the dotenv parser still respect the file-mode check?).

**Tier 3 enforcement (everything else):**
1. Caret-range pin.
2. Dependabot auto-merge on green CI for patch bumps.
3. Minor + major bumps reviewed as their own PR.

Future hybrid backends (if hybrid storage lands beyond v1: `age`, `sops`, custom shell-out to `security`/`secret-tool`) inherit the policy by classification — if they're a native binding they're Tier 1; if they're a JS wrapper around a system binary they're Tier 2.

### A.10 Known gotchas

- **`@napi-rs/keyring` is sync.** All methods are synchronous. Calling them from an event loop callback blocks. Acceptable for our use case (one call at boot, cached) but document so callers don't sprinkle calls in hot paths.
- **`@napi-rs/keyring` has no `findByPrefix`.** API surface is `Entry(service, account)` + `setPassword/getPassword/deletePassword`. We don't need enumeration — one entry, one account.
- **Linux without Secret Service daemon** (SSH session, CI, WSL2 without keyring): `Entry.getPassword()` throws. `KeychainKeyProvider` re-throws as `KeyProviderError` with a clear "Run with KUZO_PASSPHRASE set" message. `kuzo credentials status` must detect this state and explain.
- **macOS "Always Allow" sticks per binary path + content hash.** Volta/nvm/asdf swapping Node binaries triggers a fresh prompt. That's one prompt for the **master key** (unlocks the whole blob), not per credential — VSCode pattern wins here. Document that the prompt is expected after each Node upgrade.
- **`crypto.scryptSync` default `maxmem` is 32 MiB; `N=2^17 r=8 p=1` requires ~128 MiB.** Empirically verified — Node throws `Invalid scrypt params: memory limit exceeded` for any `maxmem` < ~128 MiB. **Use `maxmem: 256 * 1024 * 1024` (256 MiB)** — comfortable slack, well below typical process limits. The round-2 spec's claimed-as-verified 64 MiB was wrong; the round-3 fix lives in `SCRYPT_PARAMS` (see §A.5 `PassphraseKeyProvider`). Acceptance: unit test round-trips `initializeKey()` → `acquireKey()` with the production constant; OOM is a regression (§F.1).
- **Generation counter is stored in two different places by mode.** Keychain mode: inside the keychain entry value (JSON `{key, generation}`). Passphrase mode: in a 0600 file `~/.kuzo/credentials.generation` containing a base-10 ASCII integer. The mode-vs-storage split is intentional — passphrase mode has no keychain entry to embed in, and adding a second on-disk file the user has to back up is acceptable for the headless/CI use case. Both stores are bumped atomically before the encrypted file write (see §A.3 write path step 10).
- **Backup tools.** Time Machine and iCloud backup `~/.kuzo/credentials.enc` (good — ciphertext, safe in backups) **but** keychain entries are NOT in the home dir tree most backup tools index. A restored backup is decryptable only if the original keychain is also restored (Time Machine restores keychain too — full-system restore safe). Migrating Macs without a keychain restore = ciphertext file useless. Document in the migration runbook (F.3).
- **Windows ACL.** `fs.chmod(file, 0o600)` on Windows is a no-op for the underlying ACL. NTFS inherits from the user profile dir which is typically per-user-only. Acceptable for v1; hardening with explicit ACL is post-v1.
- **Header AAD covers KDF id.** A backup-restore that swaps the KDF id (e.g. takes a passphrase-encrypted file and tries to decrypt with keychain) fails at GCM verification — not just at "no key found." Defensive but cheap.

### A.11 Master-key + file state machine

`acquireKey()` and `initializeKey()` have different semantics depending on whether the master-key entry and `credentials.enc` exist. The CLI must NOT silently rotate the master key — that would render an existing `credentials.enc` undecryptable. Explicit state machine:

| Master-key entry | `credentials.enc` | State | Action on `kuzo credentials set <name>` | Action on `runServer()` boot |
|---|---|---|---|---|
| Present | Absent | Fresh-with-key | Use existing key (`acquireKey()`); create file with first write. | Store stays empty; first `.get()` short-circuits on file-not-found. |
| Absent | Absent | Fresh | Initialize key (`initializeKey()` writes the new key into the keychain); create file with first write. | Same as fresh-with-key (store empty). |
| Present | Present | Steady-state | Use existing key + decrypt existing file; modify map; re-encrypt. | Normal — parent-eager decrypt at first `.get()` during `loader.loadAll()`. |
| **Absent** | **Present** | **KEY_LOST** | **Refuse.** Exit 72 (`E_KEY_LOST`). Message: "The credential file at `<path>` exists, but the master key entry in the keychain is missing. The file cannot be decrypted. Run `kuzo credentials wipe --confirm` to clear both and start over, OR restore the keychain entry (e.g., Time Machine keychain restore)." | Refuse to boot. Same exit code and message via stderr. |
| Present, decrypt fails | Present | **CORRUPTED** | **Refuse.** Exit 73 (`E_FILE_CORRUPTED`). Message: "The credential file failed AES-GCM verification. Either the file was tampered with OR the master key in the keychain does not match the one used to encrypt this file. Run `kuzo credentials wipe --confirm` to start over." | Refuse to boot with same exit code. |

**Why explicit refusal beats silent re-init.** The natural code reading of "user wants to set a credential, master key missing" is "call `initializeKey()` to make a new one." Doing so would generate a fresh random key + write it to the keychain, leaving the old `credentials.enc` with an unknown-key ciphertext that can never be decrypted again. The user thinks they reset their token; in fact they lost every other credential silently. The state machine forces the user to acknowledge data loss via `wipe --confirm`.

**`kuzo credentials wipe --confirm`** is a new subcommand. Refuses to run without the literal `--confirm` flag (no `-y/--yes` shorthand). Prints:

```
This will destroy ALL stored credentials:
  - delete the master key in the keychain (service: kuzo-mcp, account: master-key)
  - delete the encrypted credential file at <path>

Affected plugins: github, jira (n credentials total)

Type 'yes' to confirm:
```

Reads `yes` (literal, case-sensitive) from stdin. Anything else aborts. Audit-emits `credential.wiped` with `{file_existed: bool, keychain_entry_existed: bool, credential_count: number}` (no names of credentials — the file's already gone by audit time anyway).

`wipe` MUST work in the `KEY_LOST` state (only the file exists) and in the `CORRUPTED` state (decrypt fails) — its job is precisely to clean up those states. It must NOT call `acquireKey()` first.

After `wipe`, the next `kuzo credentials set <name>` lands in the `Fresh` state and goes through `initializeKey()` cleanly.

---

## Part B — Provisioning UX

> Stand up `kuzo credentials set/list/delete/rotate/migrate/status` plus an inline prompt at the end of `kuzo plugins install`. Secrets never appear on the command line, ever.

### B.0 Scope

**In:** the seven subcommands (`set`, `list`, `delete`, `rotate`, `migrate`, `status`, `install` integration), the secret-input contract, lock-sharing with `kuzo plugins`, audit events.

**Out:** the underlying storage (Part A), the boot-time wiring (Part C), the server entry (Part D).

### B.1 Command surface

New command tree under `packages/cli/src/commands/credentials/`:

```
kuzo credentials set <name>             Set or update a credential. Interactive prompt by default.
                                        --stdin           Read value from stdin (single line, trimmed).
                                        -y, --yes         Skip the "this will overwrite" confirm.

kuzo credentials list                   List credential names + last-set timestamp + backend.
                                        --json            JSON output.

kuzo credentials delete <name>          Remove a credential.
                                        -y, --yes         Skip confirm.

kuzo credentials rotate <name>          Alias for `set` that emits `credential.rotated` audit
                                        instead of `credential.set`. Symmetric with semantics
                                        of `kuzo plugins rollback` vs `update`.
                                        --stdin / --yes   Same as set.

kuzo credentials migrate                One-shot import from ~/.claude/settings.json env blocks
                                        and .env files. Atomic rewrite with redaction.
                                        --source <claude|env-file|both>   Default: both.
                                        --dry-run         Show what would change; touch nothing.
                                        -y, --yes         Skip the confirmation prompt.

kuzo credentials status                 Show key-provider backend, store file path, and per-plugin
                                        credential availability (missing creds flagged red).
                                        --json            JSON output.

kuzo credentials test <name>            Verify the stored credential is accepted by its plugin's
                                        target service (first-party: GitHub /user, Jira /myself;
                                        third-party: optional KuzoPluginV2.testCredential hook).
                                        Exits 0 valid, 78 invalid, 79 no-test-available.

kuzo credentials wipe --confirm         Destroy ALL stored credentials AND the master key.
                                        Use after KEY_LOST (exit 72) or CORRUPTED (exit 73)
                                        states. Requires the literal --confirm flag (no -y/--yes
                                        shorthand) plus an interactive 'yes' confirmation. Safe
                                        to run when only one of (master-key, credentials.enc)
                                        exists — its job is precisely to clean up partial state.
```

No `get` subcommand. Rationale: `get` is footgun-shaped — pipes the value into shell history if the user redirects, exposes it on `ps aux` if a wrapper script calls it inline, and there's no good use case in v1 (the broker reads values directly; users want `list`/`status` to confirm what's set, not the raw value). If a debugging session genuinely needs to inspect, `kuzo audit --action credential.fetch_created --plugin <name>` shows what was read; the user can rotate to verify it works. To verify validity without exposure, use `kuzo credentials test <name>` — it calls a cheap API endpoint and reports OK/401 without revealing the value.

**`--help` mockups (R42).** Commander auto-generates `--help` from the option definitions. For most subcommands (`set`, `list`, `delete`, `rotate`, `test`, `wipe`) the default output is fine. For `migrate` and `status`, the flag interactions are non-obvious enough to deserve explicit example output via `.addHelpText("after", ...)`:

```
$ kuzo credentials migrate --help
Usage: kuzo credentials migrate [options]

One-shot import from ~/.claude/settings.json env blocks and project-local .env files
into the encrypted credential store, with atomic source-file redaction.

Options:
  --source <claude|env-file|both>   Sources to scan. Default: both.
  --dry-run                         Report candidates without modifying anything.
                                    Skips the equality check (may report 'would import'
                                    for values that are already stored identically).
  --force-source                    On E_CONFLICT (stored value differs from source),
                                    overwrite the stored value with the source value.
                                    Loud interactive confirmation required.
  -y, --yes                         Skip the per-source confirmation prompt.
                                    Does NOT skip --force-source confirmation.
  -h, --help                        display help for command

Examples:
  Dry-run scan, show what would change:
    $ kuzo credentials migrate --dry-run

  Only scan ~/.claude/settings.json (skip project .env files):
    $ kuzo credentials migrate --source claude

  Re-run after a previous partial failure (idempotent):
    $ kuzo credentials migrate

  Resolve a conflict by overwriting the stored value:
    $ kuzo credentials migrate --force-source

Exit codes:
   0  success
  60  read-back verification failed (impossible if scrub semantics are sane)
  74  source file is a symlink
  75  source path is not a regular file
  76  source file was modified during migration (close your editor and retry)
  77  source value differs from stored (use --force-source or set manually)

  Full table: kuzo --help-exit-codes
```

```
$ kuzo credentials status --help
Usage: kuzo credentials status [options]

Report key-provider backend, store file path, and per-plugin credential availability.
Missing credentials are flagged in red.

Options:
  --json     Emit JSON output instead of the human-readable table.
  -h, --help display help for command

JSON schema (when --json):
  {
    "kuzoHome": string,
    "keyProvider": { "id": "keychain" | "passphrase" | "null", "ready": boolean },
    "store": { "path": string, "exists": boolean, "credentialCount": number | null },
    "plugins": [
      {
        "name": string,
        "version": string,
        "missing": string[],          // names of required credentials not satisfied
        "shadowedByEnv": string[],    // names where env override hides stored value
        "available": string[]         // names that resolve to a value
      }
    ]
  }

  "credentialCount" is null when the store is locked AND the user has not yet
  triggered a keychain prompt (status is read-only; it does NOT decrypt).
```

The other subcommands' help is Commander-default — adding mockups would create drift risk for marginal value.

### B.2 Secret-input contract

**One rule: the secret never appears as a positional arg or a flag value, ever.**

| Mode | Behavior |
|---|---|
| TTY, no `--stdin` | Inquirer `password`-type prompt (echo-off). Required. |
| Non-TTY, `--stdin` | Read one line from stdin; trim trailing newline. |
| TTY, `--stdin` | Read from stdin (allows `op read 'op://Personal/GitHub/token' \| kuzo credentials set GITHUB_TOKEN --stdin` in an interactive shell). |
| Non-TTY, no `--stdin` | **Error**: "stdin is not a TTY and --stdin was not passed; refusing to silently read pipe." Exit 65 (`E_NO_INPUT_MODE`). |

**Critical:** no auto-detect of pipe-vs-tty. The user must opt in to stdin reads. Otherwise a user typing `kuzo credentials set GITHUB_TOKEN` after `cat .env \| while ...` could find a piped value silently consumed.

**Stdin protocol:** read until first newline or EOF; trim trailing `\r\n` or `\n`. Reject empty value (`E_EMPTY_VALUE`, exit 66). Reject values containing internal newlines or NUL bytes (`E_INVALID_VALUE`, exit 66).

Implementation note: the Commander action handler does NOT accept a secret argument. Type:

```typescript
interface CredentialsSetOptions {
  stdin: boolean;
  yes: boolean;
}
new Command("set")
  .argument("<name>", "Credential name (env-var-style, e.g. GITHUB_TOKEN)")
  .option("--stdin", "Read value from stdin", false)
  .option("-y, --yes", "Skip confirmation", false)
  .action(async (name: string, options: CredentialsSetOptions) => { ... });
```

There is no `.argument("<value>")` for the secret. The compiler enforces it.

### B.3 Inline-with-`plugins install` integration

After `kuzo plugins install <name>` completes consent + atomic commit, scan the freshly-installed plugin's `CredentialCapability` list:

```typescript
const required = plugin.capabilities.filter(c =>
  c.kind === "credentials" && /* env var not currently set in source */
);
if (required.length > 0) {
  // Print a section + offer to set them now.
}
```

Concretely, the install command's `printSuccess()` (`packages/cli/src/commands/plugins/install.ts`) adds a "Configure credentials?" Inquirer block at the end:

```
✓ Installed @kuzo-mcp/plugin-github@0.1.0
✓ Consent granted: 4 capabilities

This plugin needs 1 credential:
  GITHUB_TOKEN — Authenticates with the GitHub API for all operations

? Configure now? (Y/n)
  ✓ GITHUB_TOKEN
    [interactive prompt; echo-off]

Stored. To rotate: `kuzo credentials rotate GITHUB_TOKEN`.
```

With `-y`, the inline block is skipped — user gets the "configure later via `kuzo credentials set`" hint instead. Audit emits `credential.set` per credential just like the standalone `set` command.

If the credential is already set (env override OR stored value), the inline block skips that entry and shows `✓ GITHUB_TOKEN (already configured via env)` or `(via keychain)`. Re-running install doesn't re-prompt for existing creds.

Optional creds (`optionalCapabilities` with `kind: "credentials"`) are listed but not required — user can skip.

**First-install onboarding hint (R40).** After EVERY successful `kuzo plugins install`, the success message also prints the Claude Code wiring nudge — UNLESS the wiring is already detected:

```
Plugin installed.

⚠ To use this plugin with Claude Code, add the kuzo MCP server to your settings:
  1. Open ~/.claude/settings.json
  2. In mcpServers, add:
       "kuzo": { "command": "kuzo", "args": ["serve"], "env": {} }
  3. Restart Claude Code

Already wired? You can ignore this. To suppress: kuzo plugins install <name> --no-onboarding-hint
```

**Detection of "already wired"** — `printSuccess()` checks if `~/.claude/settings.json` exists AND parses, AND `mcpServers.kuzo` is set, AND its `command` is `"kuzo"` (or matches one of the canonical pre-2.6 patterns: `"node"` with args ending in `@kuzo-mcp/core/dist/server.js`). If all true, skip the hint. After the user wires up correctly once, the second-and-later `kuzo plugins install` invocations skip the hint automatically.

**Flag handling:** `--no-onboarding-hint` is a sticky pref shorthand — the install command accepts it per-invocation; if a user wants to permanently suppress, they can set `KUZO_NO_ONBOARDING_HINT=1` in their shell profile. Both produce identical "skip the hint" behavior. Document in `--help`.

The new flag is added to `packages/cli/src/commands/plugins/install.ts`'s option list. Mirrored on `update` (re-install after manual settings.json edit) for parity. Not on `uninstall` (success message there is different).

### B.4 `kuzo credentials migrate` — the footgun command

Reads:
- `~/.claude/settings.json` — finds MCP server entries whose `command` matches `kuzo`, `node` with `@kuzo-mcp/core`, or any prior canonical paths. Reads each entry's `env: { … }` block.
- `.env` files via a **bounded ancestor walk (R22)**: starting from cwd, walk up at most **5 ancestor directories**, stopping at the `$HOME` boundary (never above home), considering each directory's `.env` only if a sibling `package.json` declares `@kuzo-mcp/cli` (or any `@kuzo-mcp/*` package) in `dependencies`, `devDependencies`, OR `peerDependencies`. Substring matches in `description`/`keywords`/etc. do NOT qualify. Additionally considers `$HOME/.env`. NEVER considers `/.env`, `/etc/.env`, or any `.env` outside `$HOME`.

For each candidate key:
1. Filter by **known credential env names** — the union of `CredentialCapability.env` values across installed plugins (via `index.json`) plus the legacy plain names (`GITHUB_TOKEN`, `JIRA_*`, etc.). Other env vars (`LOG_LEVEL`, etc.) are not touched.
2. **Re-run semantics (R20):** Three possible per-key states:
   - **New** — present in source, not in store → queue for import + source-rewrite.
   - **Already migrated** — present in source AND in store with identical value → queue for source-rewrite only (the migrate already imported; we're cleaning up the source file from a previous partial run).
   - **Conflict** — present in source AND in store with **different** values → `E_CONFLICT` (exit 77). Error message: "`<NAME>` is stored with a different value than the one in `<source>`. Resolve manually via `kuzo credentials set <NAME>` (interactive) OR re-run with `--force-source` to overwrite the store with the source value." Do NOT proceed past the dry-run summary in conflict state; the user has to choose.
3. Otherwise: queue for import.

After collecting candidates, print a dry-run-style summary:

```
This migration will:
  IMPORT 3 credentials from ~/.claude/settings.json:
    GITHUB_TOKEN     (will be moved to keychain-encrypted store)
    GITHUB_USERNAME  (will be moved to keychain-encrypted store)
    JIRA_API_TOKEN   (will be moved to keychain-encrypted store)
  REWRITE 1 file:
    ~/.claude/settings.json (the 3 keys above will be removed from the kuzo MCP entry's env block)

? Proceed? (y/N)
```

With `--dry-run`, exit here. **`--dry-run` deliberately reports the maximum candidate set (R21).** It does NOT call `store.get(name)` to compare against existing values, because that would trigger `keyProvider.acquireKey()` → a real keychain prompt on macOS for a read-only operation. Dry-run lists every key present in source as "would import." An actual `migrate` run still does the proper compare (new/already-migrated/conflict per R20). Documented in `--help`: "`--dry-run` reports the maximum set of changes; an actual run may skip already-stored matching values silently."

On confirm:
1. **Pre-rewrite safety checks (R18) — every source file:**
   a. `fs.lstat(path)` — fail with `E_SYMLINK_REFUSE` (exit 74) if `isSymbolicLink()`. Migrate never follows symlinks; the canonical path is the only legal target.
   b. `fs.stat(path)` — fail with `E_NOT_REGULAR_FILE` (exit 75) if not `isFile()` (directories, FIFOs, sockets, etc. all rejected).
   c. Open with `fs.open(path, "r")` + `fs.fstat(fd)` and compare the (`dev`, `ino`) pair to the `lstat` result. Mismatch → fail with `E_SYMLINK_REFUSE` (race-condition guard: attacker swapped the file between `lstat` and `open`).
   d. On Linux, pass `O_NOFOLLOW` (`fs.constants.O_NOFOLLOW`) to `fs.openSync` for both the read AND the tmp write paths.
   e. Take a **content snapshot** (Buffer) of the source file at this point — used for the editor-collision check at step 4.
2. For each credential:
   a. `store.set(name, value)` — encrypts + writes.
   b. **Read-back-verify**: `store.get(name) === value`. Byte compare. If mismatch, abort the entire migration (rollback any earlier `store.set` calls for this run by restoring the original encrypted file from a memory copy taken at the start), surface `E_READBACK_FAIL`, exit 60.
   c. Audit `credential.migrated` with key name only and `source: "claude-settings" | "env-file"`.
3. After **all** read-backs pass, rewrite each source file. **Both formats parse → drop → re-serialize; neither uses line-strip.** This matters: `.env` syntax supports quoted multi-line values, escape sequences, and `export` prefixes (the `dotenv` library handles them at boot via `loadDotenv`); a naive line-strip would leave orphaned cleartext on disk for any credential whose value spans multiple lines. The redaction parser MUST be the SAME one the loader uses at boot — `dotenv@latest`'s `parse()` for `.env` and `JSON.parse` for `settings.json` — so what we drop is exactly what would have been loaded.
   - `settings.json`: `JSON.parse` the in-memory snapshot from step 1.e → delete each migrated key from the kuzo MCP entry's `env` block → `JSON.stringify(..., null, 2)` (preserve indentation per repo convention; falls back to original-source-detected indent if the file used 4-space or tabs) → write to `settings.json.tmp` (open with `O_NOFOLLOW | O_CREAT | O_WRONLY`, mode `0600`), `fs.fsync(fd)` on the data, `rename` over `settings.json`, `fs.fsync` the **containing directory's** fd so the rename hits disk. **No `.bak` file.**
   - `.env` files: same atomic dance with the parser swap. `import { parse } from "dotenv"` (the actual loader dep already in our tree) → drop matching keys from the parsed Record → re-serialize. Re-serialization is the only step `dotenv` doesn't ship today; implement it as a small helper that emits one `KEY="value"` line per key with values escaped per dotenv's quoted-string rules (`\n` → literal `\n`, `"` → `\"`, etc.). Preserve comments AND blank lines from the source by walking the source lines and, for each non-`KEY=` line, copying it verbatim into the output between the dropped/kept key entries. Acceptance fixture (§F.1): a `.env` with:
     ```
     # leading comment, preserved
     GITHUB_TOKEN="ghp_xxxxx
     trailing-line-that-is-actually-part-of-the-value"
     LOG_LEVEL=info
     export OPENAI_API_KEY=sk-...

     # trailing comment, preserved
     ```
     After migrate, the rewritten file MUST contain ONLY the comments, blank line, `LOG_LEVEL=info`, and `export OPENAI_API_KEY=sk-...` lines — no fragment of the `GITHUB_TOKEN` quoted-value second line. Round-trip via `dotenv.parse(read(.env))` after the rewrite to confirm the result is parseable (no orphan quote-state).

   **Why parse-don't-line-strip matters here.** Brief's vector 3 (dotfiles/backup leaks) is exactly what migrate exists to prevent. A line-strip that leaves `trailing-line-that-is-actually-part-of-the-value"` on disk is the worst-of-both: the user thinks they're protected (`kuzo credentials list` shows the token stored), but the source file has half the secret in cleartext. Specifying the parser closes the gap before code lands.
4. **Editor-collision check (R19) — just before each rename:** re-read the source file with the same flags, byte-compare against the snapshot Buffer from step 1.e. If different → abort with `E_SOURCE_MUTATED` (exit 76) and instruct: "the source file `<path>` was modified during migration; close your editor and retry. Already-imported credentials remain in the store; re-running `kuzo credentials migrate` is safe (already-stored matching values are skipped per R20)."
4b. **Post-rewrite redaction-verify (round-2 advisory).** After the rename succeeds but before reporting success to the user, re-read the on-disk file and parse it with the SAME parser that loadDotenv uses at boot (`dotenv.parse` for `.env`, `JSON.parse` for `settings.json` traversing to `mcpServers.kuzo.env`). Assert ZERO of the just-redacted credential names appear in the parsed output. If any do → abort with `E_READBACK_FAIL` (exit 60) and surface: "redaction completed but parser still finds `<NAME>` in `<source>` — possible parser drift between loader and migrate. The credential is stored; the source file may still contain it. Manually inspect `<source>` and re-run." This is the **self-healing defense against dotenv parse-semantics drift** between boot's `loadDotenv()` and migrate's redaction parser — if a minor dotenv bump under Tier-2 caret-range changes quoted-string handling, `export` matching, or escape semantics, the cross-version drift surfaces here as a hard failure instead of as a silent on-disk leak. Cheaper than pinning dotenv exact across both packages; the invariant is the actual property we care about (parser-of-record agrees that the secret is gone).
5. If any source rewrite fails:
   - The credential is already in the store (succeeded at step 2).
   - The source file still has the cleartext value (worse — duplicated).
   - Audit `credential.migration_partial` with the failed source path.
   - Surface the **explicit per-key remediation block (R23)**:

```
Migration partially succeeded.
  ✓ Imported into store: GITHUB_TOKEN, JIRA_API_TOKEN, JIRA_HOST
  ✓ Redacted from: ~/.env
  ✗ Could NOT redact: ~/.claude/settings.json (E_PERMISSION_DENIED)

To complete redaction manually:
  1. Open ~/.claude/settings.json in your editor
  2. Find the mcpServers.kuzo.env block
  3. Delete these keys (leave the block; just remove the values):
       "GITHUB_TOKEN": "ghp_...",
       "JIRA_API_TOKEN": "...",
       "JIRA_HOST": "..."
  4. Save and run: kuzo credentials migrate
     (re-run is safe; already-stored values are skipped)

Your credentials are stored securely. The source file still contains them as a fallback until you complete step 3.
```

   The exit code is non-zero (path-specific — `E_PERMISSION_DENIED`, `E_SOURCE_MUTATED`, etc.), so CI runs that swallow the human-formatted block can still react.
   - **Do NOT roll back the store** — the user has the source as a fallback. Better duplicate than missing.
6. After source rewrites: zero all in-memory cleartext per §C.5 honest-zero-fill conventions (the master key Buffer overwrites are real; the per-credential string drops are reference-only).

**Failure-mode invariants**:
- **No `.bak` files anywhere.** Atomic tmp+rename only. Reason: `.bak` files are exactly the kind of forgotten plaintext leak that the brief's vector 3 (backups / dotfiles commits) talks about.
- **In-memory secret zeroing happens AFTER the success path completes, not earlier.** Read-back-verify must have something to compare against; clearing the buffer right after `store.set()` returns leaves nothing to verify with. The brief's Q7(d) calls this out explicitly.
- **Audit log redaction.** Audit entries name the credential KEY and the source, never the value. The audit helper `auditLogger.log({...})` is already shape-locked from 2.5c — `details: { credentialKey: name, source }` is fine.
- **No partial-success rollback for the store.** If we rolled back, the user might be left with a partially-redacted `settings.json` and no stored credentials — strictly worse than "stored + source has duplicate."
- **Confirm prompt cannot be `-y` by default for migrate.** `--yes` is opt-in for automation, but the prompt is the documented happy path. (We're rewriting a file owned by the user's editor; explicit consent matters.)
- **Symlinks are refused, not followed (R18).** No `O_NOFOLLOW` follow, no `lstat`-then-`fstat`-and-pray. Each source file is checked at three independent points (`lstat`, `stat`, `fstat`-after-`open`) and the (`dev`, `ino`) tuples must agree.
- **Source-file mutation during the rewrite window aborts (R19).** Snapshot at step 1.e, byte-compare just before rename. If different, abort the rewrite of THAT source (other sources may still complete). The user's editor takes precedence; we never clobber.
- **`.env` walk is bounded (R22).** 5 ancestor levels max, never above `$HOME`, only directories whose `package.json` declares `@kuzo-mcp/*` as a real dep. Eliminates "we walked from `/Users/seantokuzo/foo/bar/.env` up to `/.env` and ate something nobody asked us to."

#### Re-run semantics (R20)

Migrate is **idempotent**: re-running after a partial failure is the documented recovery path. Three cases per source file × per credential:

| State | Source file | Store | Action on re-run |
|---|---|---|---|
| Already migrated | Has the key in cleartext | Has same value | Rewrite-only (strip from source). No re-import. |
| New | Has the key in cleartext | Missing OR has same value | Import + rewrite. |
| Conflict | Has the key in cleartext | Has a DIFFERENT value | `E_CONFLICT` (exit 77); user resolves manually via `kuzo credentials set <NAME>` OR re-runs with `--force-source`. |
| Done | Does NOT have the key | Has any value | No-op. |

The per-source-file rewrite is independent — succeeded `.env` rewrites are NOT retried even if `settings.json` rewrite is still pending. Each source file has its own dry-run summary and its own success/failure exit.

`--force-source` is the explicit "overwrite-stored-with-source" escape hatch for conflict resolution. Loud confirmation prompt (no `-y` allowed): "You are about to overwrite the stored value of `<NAME>` with the cleartext from `<source>`. The current stored value will be irrecoverable. Type 'yes' to confirm:". Audit-emits `credential.set` with `details: { credentialKey, source: "<source path>", reason: "migrate --force-source" }`.

### B.5 `kuzo credentials list` and `status`

`list` output:

```
NAME             BACKEND      LAST UPDATED
GITHUB_TOKEN     keychain     2026-05-15 10:32
JIRA_API_TOKEN   keychain     2026-05-15 10:32
JIRA_EMAIL       keychain     2026-05-15 10:32
JIRA_HOST        keychain     2026-05-15 10:32
```

`--json` returns:

```json
{
  "backend": "keychain",
  "storeFile": "/Users/sean/.kuzo/credentials.enc",
  "credentials": [
    { "name": "GITHUB_TOKEN", "lastUpdated": "2026-05-15T10:32:00.000Z" },
    ...
  ]
}
```

(Note: the table heading `LAST UPDATED` is human-readable formatting; JSON keys are `camelCase` per repo convention — `lastUpdated`. Heading vs key naming intentionally differs.)

`status` is broader — surfaces:

```
Backend
  Key provider:   keychain (@napi-rs/keyring, service=kuzo-mcp account=master-key)
  Store file:     ~/.kuzo/credentials.enc  (mode 0600, size 412 B, modified 2026-05-15 10:32)

Credentials
  GITHUB_TOKEN     ✓ set (store)
  GITHUB_USERNAME  ✓ set (env override: KUZO_TOKEN_GITHUB_USERNAME)
  JIRA_HOST        ✓ set (store)
  JIRA_EMAIL       ✓ set (store)
  JIRA_API_TOKEN   ✓ set (store)

Plugins
  ✓ git-context        no credentials required
  ✓ github             all required credentials available
  ✓ jira               all required credentials available

Environment overrides active
  KUZO_TOKEN_GITHUB_USERNAME (value redacted)
```

`status` walks the installed-plugins `index.json` to know which capabilities to surface. For un-installed but enabled plugins (dev-mode), it falls back to scanning the workspace.

### B.6 Lock sharing with `kuzo plugins`

`kuzo plugins install/update/uninstall/rollback` already acquires `~/.kuzo/plugins/.lock` for write operations. `kuzo credentials set/delete/rotate/migrate/wipe` also writes to `~/.kuzo/credentials.enc`. Both touch the kuzo-home directory.

**Decision:** single shared lock at `~/.kuzo/.lock`. `kuzo plugins install` + `kuzo credentials set` cannot run concurrently. Acceptable for personal use — these are interactive commands. Move `lock.ts` from `packages/cli/src/commands/plugins/` to `packages/cli/src/lock.ts` (shared utility); `pluginsLockPath()` becomes `kuzoHomeLockPath()`. Existing `kuzo plugins` exit code 30 (`E_LOCK_CONTENTION`) stays.

`list`, `status`, `test`, and `verify` are read-only — no lock.

**Split helper functions (R28).** The existing `acquireLock()` in `packages/cli/src/commands/plugins/lock.ts` calls `ensurePluginsRoot()` to create `~/.kuzo/plugins/` before locking. After credentials lands, `kuzo credentials set` runs in a brand-new install with no plugins yet — the credentials-only operation should NOT auto-create the plugins dir. Split:

```typescript
// packages/cli/src/paths-fs.ts (or wherever)
export function ensureKuzoHome(): void {
  fs.mkdirSync(kuzoHome(), { recursive: true, mode: 0o700 });
}

export function ensurePluginsRoot(): void {
  ensureKuzoHome();
  fs.mkdirSync(pluginsRoot(), { recursive: true, mode: 0o700 });
}
```

- Credentials commands call `ensureKuzoHome()` only.
- Plugin commands call `ensurePluginsRoot()`.
- `acquireLock()` calls `ensureKuzoHome()` unconditionally (lock lives at the home level), with the plugin-specific `ensurePluginsRoot()` invoked separately by plugin commands when they need the plugins subdir.

#### B.6.1 Upgrade concurrency for the lock-path move (R27)

The 0.0.2 → 0.1.0 upgrade moves the lock from `~/.kuzo/plugins/.lock` to `~/.kuzo/.lock`. There's an unavoidable transition window where a `kuzo plugins install` from 0.0.2 acquires the OLD lock while a `kuzo credentials set` from 0.1.0 acquires the NEW lock. They run concurrently with no protection — both could write `~/.kuzo/plugins/index.json` simultaneously.

**Mitigation: the new CLI (0.1.0) acquires BOTH locks during the transition window.**

```typescript
// packages/cli/src/lock.ts (new)
export async function acquireKuzoLock(): Promise<LockHandle> {
  // 1. Canonical (new) lock
  const canonical = await acquireFileLock(kuzoHomeLockPath());

  // 2. Legacy (old) lock — exists only during transition
  let legacy: LockHandle | undefined;
  try {
    legacy = await acquireFileLock(legacyPluginsLockPath()); // ~/.kuzo/plugins/.lock
  } catch (err) {
    if (err instanceof LockBusyError) {
      // A 0.0.2 process holds the legacy lock. Surrender the canonical, surface.
      await canonical.release();
      throw new LockCrossVersionError(
        "Another kuzo process is running (possibly an older version). Wait for it to finish and retry."
      );
    }
    // Legacy lock dir doesn't exist (fresh install) — that's fine.
  }

  return {
    release: async () => {
      if (legacy) await legacy.release();
      await canonical.release();
    },
  };
}
```

Release order is **reverse** of acquire (legacy first, then canonical). If the legacy acquire fails with `LockBusyError`, release the canonical and surface `E_LOCK_CROSS_VERSION` (exit code 30, same as in-version lock contention — the user's remedy is the same: wait and retry).

**Deprecation timeline:** after three releases (or six months from 0.1.0, whichever is later), drop the legacy-lock acquire. Documented in §F.4 as a tracked obligation.

`ensureKuzoHome()` is still called inside `acquireKuzoLock()` (the canonical lock lives at the home level), but `ensurePluginsRoot()` is NOT — the legacy lock path's parent dir creation is intentionally skipped, because creating `~/.kuzo/plugins/` just to hold a transitional lock would leak structure onto fresh-install boxes that don't yet have any plugins.

### B.7 Audit events

Extend the `AuditAction` union (`packages/core/src/audit.ts`) with:

```typescript
| "credential.set"
| "credential.deleted"
| "credential.rotated"
| "credential.migrated"
| "credential.migration_partial"
| "credential.store_unlocked"
| "credential.store_locked"
| "credential.passphrase_consumed"  // PassphraseKeyProvider.acquireKey post-derivation (R8)
| "credential.scrub_disabled"       // --no-scrub flag OR KUZO_NO_ENV_SCRUB=1 (R17)
| "credential.wiped"                // kuzo credentials wipe --confirm (R9)
| "credential.tested"               // kuzo credentials test <name> (R33)
| "credential.refreshed_in_flight"  // file-watch IPC refresh propagated to running plugins (R34)
| "audit.forged_plugin_field"       // parent caught a child impersonating another plugin (R16)
| "audit.forged_action"             // parent caught a child emitting a non-allowlisted action (round-1 advisory)
```

`AuditEvent` shape additionally gains a `source: "parent" | "child"` field, stamped at write time by the parent (see §C.10 action-class allowlist). Existing entries (pre-2.6) have no `source` field — consumers MUST treat missing as `"parent"` because pre-2.6 only the parent wrote to `audit.log`.

Event payloads (the `details` field) never include the value. They include:
- `credentialKey` — the env-var-style name.
- `source` — for `migrated` events: `"claude-settings" | "env-file"`. For `store_unlocked`: `"keychain" | "passphrase"`.
- `before` / `after` — for length comparisons (e.g. on rotate) without echoing values. Optional.
- `salt_fingerprint` — for `passphrase_consumed`: sha256 of the salt truncated to 16 hex chars (R8).
- `reason` — for `scrub_disabled`: which kill-switch triggered it (`"--no-scrub flag"` or `"KUZO_NO_ENV_SCRUB=1"`) (R17).
- `file_existed` / `keychain_entry_existed` / `credential_count` — for `wiped`: the pre-wipe state, so audit reviewers can distinguish "user wiped a fully-populated store" from "user wiped a KEY_LOST state" (R9).
- `outcome` + `http_status` — for `tested`: `"valid" | "invalid"` outcome plus the HTTP status from the service probe (R33). No body, no token.
- `claimed_plugin` / `actual_plugin` / `child_pid` — for `audit.forged_plugin_field`: surfaced when a plugin child writes an audit event with a `plugin` field that doesn't match its declared identity (R16).

Existing `credential.client_created` / `.raw_access` / `.raw_denied` / `.fetch_created` stay. The new write-side events are emitted by the CLI handlers (not by the store directly — the store doesn't have audit context for who initiated the write). The CLI passes a request-scoped `AuditLogger` instance into store methods, or wraps the call site.

**Recommended split:** the store emits `store_unlocked` / `store_locked` (lifecycle it owns). The CLI emits the user-facing events (`set`, `deleted`, `rotated`, `migrated`, `tested`, `wiped`). The PassphraseKeyProvider emits `passphrase_consumed` from its own `acquireKey`/`initializeKey` post-derivation (the auditLogger is threaded in via `chooseKeyProvider(auditLogger)` — see §A.5). The parent's IPC receiver emits `audit.forged_plugin_field` when a child impersonates another plugin's identity in an audit emission (see §C.10).

**Writer-trust model (R16).** All audit emissions from the parent process (CLI, `runServer()` boot path, store, audit-logger itself) write directly to `~/.kuzo/audit.log`. Audit emissions from plugin children flow through IPC to the parent, which validates the `plugin` field matches the child's declared identity, then writes. See §C.10 for the IPC routing rules and the synthetic-test acceptance criterion. The plugin-host (child) STOPS calling `appendFileSync(audit.log)` directly.

### B.8 Known gotchas

- **Inquirer's `password`-type echo-off behavior is reliable on TTY, but **not** in some VSCode terminal integrations.** If `process.stdout.isTTY === true` but `process.stdin.isTTY === false`, refuse with a clear error rather than silently reading visible input.
- **Trim only trailing newlines.** `--stdin` users may paste tokens via `pbpaste \| kuzo credentials set ... --stdin` — leading whitespace is part of the secret on the very rare token type that has it; trailing newline is shell artifact. `value.replace(/\r?\n$/, "")` only.
- **Confirm-prompt-with-`-y`-allowed-but-not-default.** `migrate` skips the confirm with `--yes`. Without it, the prompt is required even in non-TTY (where it auto-fails on no-TTY input — that's intentional, forces explicit `--yes`).
- **`pbpaste` on macOS strips the trailing newline implicitly.** No additional handling needed beyond the trim.
- **Linux terminals that don't support echo-off** (rare but possible — some serial console setups). Inquirer falls back to plain echo. Refuse rather than echo: detect via `process.stdin.isRaw` after Inquirer's setup. Edge case; document in F.4 risks.
- **Migration of `~/.claude/settings.json` is tied to Claude Code's file format.** That file's schema isn't formally versioned. If the schema changes (new wrapper around `mcpServers`), the migration parser fails closed — surface "could not parse settings.json; manually remove the env block." Acceptable for v1.
- **Migrate from project-local `.env` may pick up unintended keys.** Filter strictly by the known-credential-names set; don't migrate anything not in the union of plugin `CredentialCapability.env` values.

### B.9 `kuzo credentials test <name>` — validity verification (R33)

Dropping `get` was correct, but the user has no way to verify a stored credential actually works until a tool call fires and returns 401. By then the user has no signal whether it's a stale token, a plugin bug, or migrate corruption. `test` bridges that gap.

**Resolution flow:**
1. Look up the plugin owning `<name>` via the union-of-`CredentialCapability` scan used by `migrate` (same source of truth). Multiple plugins claiming the same env name is a hard error; the user must namespace.
2. **First-party plugins** (`github`, `jira`) — call a known cheap endpoint via the plugin's client factory:
   - GitHub: `GET /user` (`https://api.github.com/user`) — checks token validity + scope.
   - Jira: `GET /myself` (`https://<host>/rest/api/3/myself`) — checks email + token.
3. **Third-party plugins** — relies on a new OPTIONAL hook on `KuzoPluginV2`:

```typescript
// packages/types/src/index.ts
export interface KuzoPluginV2 extends KuzoPluginBase {
  // ... existing fields
  /**
   * OPTIONAL. If provided, called by `kuzo credentials test <name>`.
   * Performs a single, cheap, idempotent API call to the plugin's service to
   * verify the named credential is accepted. MUST NOT mutate any state on the
   * remote system.
   *
   * Returns:
   *   { ok: true, message?: string } — credential accepted, optional human-readable detail.
   *   { ok: false, message: string, httpStatus?: number } — rejected. Message is shown to the user.
   *   throws — uncaught error; reported as "test failed: <error>"
   */
  testCredential?(
    name: string,
    broker: CredentialBroker,
  ): Promise<{ ok: boolean; message?: string; httpStatus?: number }>;
}
```

4. If the plugin doesn't expose `testCredential`, print:
   ```
   ⓘ GITHUB_TOKEN — presence verified, but plugin <plugin-name> does not expose a validity test.
     Stored: yes (length 40). Try a tool call to confirm runtime behavior.
   ```
   Exit 79 (`E_TEST_UNAVAILABLE`).
5. Output formats:
   ```
   ✓ GITHUB_TOKEN — authenticated as seantokuzo
   ✗ GITHUB_TOKEN — HTTP 401 unauthorized (token may be expired or revoked)
   ✗ GITHUB_TOKEN — DNS resolution failed (network problem)
   ```
6. Exit codes: `0` valid, `78` (`E_CRED_INVALID`) API rejected, `79` (`E_TEST_UNAVAILABLE`) no test hook, generic non-zero for transport/parse errors.
7. **Audit event:** `credential.tested` with `details: { credentialKey, plugin, outcome: "valid" | "invalid" | "no_test", http_status?: number }`. Never the value.

`test` is read-only. No lock. The credential read goes through the parent's `EncryptedCredentialStore.get()` — which means in the keychain-mode case, running `test` triggers ONE keychain prompt on macOS first-run, same as the first stored-credential resolution at `runServer()` boot. After that, subsequent `test` invocations within the same process re-acquire (because each CLI invocation is a fresh process; no parent-side persistent cache between invocations).

### B.10 Exit codes — consolidated table (R36)

Implementers need one place to look up exit-code semantics. The mapper lives at `packages/cli/src/commands/credentials/errors.ts` and `packages/cli/src/commands/plugins/errors.ts`.

| Code | Symbol | Source | Meaning |
|---|---|---|---|
| 0 | OK | any | Success |
| 30 | `E_LOCK_CONTENTION` | shared | Another kuzo process holds the lock |
| 30 | `E_LOCK_CROSS_VERSION` | credentials/plugins | A 0.0.2 process holds the legacy lock (R27) |
| 60 | `E_READBACK_FAIL` | migrate | Read-back-verify did not match the stored value |
| 65 | `E_NO_INPUT_MODE` | set/rotate | stdin not TTY and `--stdin` not passed |
| 66 | `E_EMPTY_VALUE` / `E_INVALID_VALUE` | set/rotate | Value rejected (empty / NUL / embedded newline) |
| 71 | `E_NO_KEY_PROVIDER` | serve/set | `KUZO_DISABLE_KEYCHAIN=1` without `KUZO_PASSPHRASE` (now resolved to `NullKeyProvider` per R10 — the exit code remains reserved for any future hard-fail path that requires a real key provider but lacks one) |
| 72 | `E_KEY_LOST` | set/serve | `credentials.enc` exists but keychain entry missing |
| 73 | `E_FILE_CORRUPTED` | any | GCM verification failed (bad key OR tampered file OR generation mismatch) |
| 74 | `E_SYMLINK_REFUSE` | migrate | Source file is a symlink |
| 75 | `E_NOT_REGULAR_FILE` | migrate | Source path is not a regular file (directory / FIFO / socket) |
| 76 | `E_SOURCE_MUTATED` | migrate | Source file changed during migration |
| 77 | `E_CONFLICT` | migrate | Source value differs from stored value |
| 78 | `E_CRED_INVALID` | test | API rejected the credential |
| 79 | `E_TEST_UNAVAILABLE` | test | Plugin doesn't expose `testCredential` |
| 80 | `E_SERVER_BOOT_FAILED` | serve | `runServer()` threw before MCP transport connect. **Moved from 70 per R44 to avoid the sysexits.h `EX_SOFTWARE=70` overlap.** |

(Plugin-domain codes 10–19 from §C.7 of 2.5e provenance, 40–53 from 2.5e install/D.3 stay unchanged; cross-referenced via the existing `packages/cli/src/commands/plugins/errors.ts`.)

**Acceptance (§F.1):** Every error code in §B.10 has a corresponding `exitCodeForXXXError(err)` mapper in `packages/cli/src/commands/credentials/errors.ts`, and a unit test enumerates them.

### B.11 CLI `preAction` hook update (R37)

The existing CLI's `preAction` hook at `packages/cli/src/index.ts:60-68` refuses to run anything not in `noConfigCommands` if `isConfigured()` returns false. `isConfigured()` is shorthand for "`process.env.GITHUB_TOKEN` is defined." For a fresh install with no env vars set, `isConfigured()` is false → every command is refused.

New `credentials` and `serve` subcommands MUST be in `noConfigCommands`, otherwise a fresh install can't reach the `kuzo credentials set` command that would unblock further work — chicken-and-egg.

**Patch in 2.6:** add `"credentials"` and `"serve"` to `noConfigCommands`. The other "no-config" entries (existing `consent`, `permissions`, `revoke`, `audit`, `plugins`) stay.

**Long-term (open question §F.2):** replace `isConfigured()` with `CredentialSource.has("GITHUB_TOKEN")` so post-2.6 users who provision credentials exclusively via `kuzo credentials set` (no env vars) don't get the no-config warning. Requires plumbing the credential source into the CLI's pre-action context. Filed as an open question — out of scope for round 3.

---

## Part C — Broker upgrades

> Insert credential-store wiring + `process.env` scrub into the server boot sequence. Pin ordering invariants in code so they cannot regress silently. Add lazy fetch, third-party factory registration, and write-side audit. Wire shutdown scrub.

### C.0 Scope

**In:** `server.ts` boot refactor (extract `runServer()`, keep self-invocation guard for direct-node parity test); `loader.ts` source swap (CredentialSource for ConfigManager.extractPluginConfig); env-override collection + scrub at boot; parent-eager decrypt in the store (one keychain prompt during `loader.loadAll()` for the first stored credential needed, zero prompts if env overrides satisfy everything); third-party `getClient` factory registration on `PluginContext.credentials`; shutdown hooks; new audit events plumbed; `node:child_process` ESLint ban in `server.ts` + `loader.ts`.

**Out:** the storage itself (Part A); the CLI (Part B); the `kuzo serve` bin wrapping (Part D).

### C.1 Boot sequence (the pinned-ordering bit)

`packages/core/src/server.ts` today inlines its `main()` at file-eval time. Refactor into an exported `runServer()` that the new `kuzo serve` command in `@kuzo-mcp/cli` calls:

```typescript
// packages/core/src/server.ts (rewritten)

export interface RunServerOptions {
  /** Skip the process.env scrub (debug only — emits a loud warning). */
  scrub?: boolean;
}

export async function runServer(options: RunServerOptions = {}): Promise<void> {
  const doScrub = options.scrub !== false;
  const logger = new KuzoLogger("kuzo-mcp");

  // 1. install exit guard (existing — must run before anything spawns children)
  installExitGuard();

  // 2. config + dotenv (existing — populates process.env from .env if present)
  const configManager = new ConfigManager();

  // 3. consent + audit (existing — paths now go through @kuzo-mcp/core/paths)
  const consentStore = new ConsentStore({ consentDir: kuzoHome() });
  const auditLogger = new AuditLogger({ logDir: kuzoHome(), logger });

  // 4. ★ NEW: credential store + key provider, both INERT — no I/O, no decrypt,
  //    no keychain prompt yet. acquireKey() is the only method that touches an
  //    external system, and it doesn't run until step 10. The auditLogger is
  //    threaded into PassphraseKeyProvider so it can emit credential.passphrase_consumed
  //    on first derivation.
  const keyProvider = chooseKeyProvider(auditLogger);
  const credentialStore = new EncryptedCredentialStore({
    filePath: credentialsFilePath(),
    keyProvider,
    auditLogger,
    logger,
  });

  // 5. ★ NEW: build the set of declared credential env names from enabled plugins.
  //    Reads STATIC `package.json#kuzoPlugin.capabilities` only — installed mode
  //    reads `~/.kuzo/plugins/<name>/current/pkg/package.json`, dev mode reads
  //    `packages/plugin-*/package.json`. NO dynamic import of any plugin entry
  //    module — that would execute top-level code before the scrub at step 7.
  const declaredEnvNames = await collectDeclaredCredentialEnvNames(
    configManager.getPluginConfig(),
  );

  // 6. ★ NEW: collect env overrides for declared names + KUZO_TOKEN_* pattern
  const envOverrides = collectEnvOverrides(declaredEnvNames);

  // 7. ★ NEW: scrub matched names from process.env BEFORE any child can inherit.
  //    KUZO_PASSPHRASE is unconditionally scrubbed inside scrubProcessEnv via the
  //    ALWAYS_SCRUB constant (see §A.7) — neither the --no-scrub flag NOR the
  //    KUZO_NO_ENV_SCRUB kill-switch exempt the passphrase. PassphraseKeyProvider
  //    captured the value at construction in step 4 and overwrites its field once
  //    acquireKey() runs in step 10.
  if (doScrub) {
    scrubProcessEnv([
      ...declaredEnvNames,
      ...Object.keys(envOverrides),
    ]);
  } else {
    // --no-scrub: declared-env-names stay in process.env, but KUZO_PASSPHRASE
    // is still removed by the always-scrub path inside scrubProcessEnv.
    scrubProcessEnv([]);
    logger.warn(
      "process.env scrubbing DISABLED (--no-scrub). Plugin children may inherit credential env vars. KUZO_PASSPHRASE is still scrubbed.",
    );
    auditLogger.log({
      plugin: "kuzo",
      action: "credential.scrub_disabled",
      outcome: "allowed",
      details: { reason: "--no-scrub flag" },
    });
  }

  // 8. ★ NEW: credential source (env override > store; the store stays cold
  //    until the first store.get() fires in step 10).
  const credentialSource = new CredentialSource(credentialStore, envOverrides);

  // 9. plugin loader — note the registry argument is FIRST per loader.ts:38-44.
  //    Hoist the registry instance so the shutdown hook (step 13) can reach it
  //    without going through loader.registry (cleaner separation, matches the
  //    pre-2.6 code's top-level handle).
  const registry = new PluginRegistry();
  const loader = new PluginLoader(
    registry,
    configManager,
    new KuzoLogger("loader"),
    consentStore,
    auditLogger,
    credentialSource,        // ← new constructor arg
  );

  // 10. load plugins. For each plugin, loader calls credentialSource.extractForPlugin().
  //     The FIRST credentialSource.get() that hits credentialStore (i.e., not satisfied
  //     by an env override) triggers credentialStore.loaded() → keyProvider.acquireKey()
  //     → keychain prompt (macOS) OR scrypt KDF (passphrase). Decrypted blob lands in
  //     the parent's in-memory cache; every subsequent read across all plugins hits the
  //     cache. If every plugin's required credentials are satisfied by env overrides,
  //     the store is never decrypted, the keychain is never touched. The per-plugin
  //     resolved Map is then serialized through IPC into the child process; the child
  //     reconstructs DefaultCredentialBroker from that Map and has no KeyProvider of
  //     its own.
  await loader.loadAll();

  // 11. freeze prototypes (existing — must run AFTER loadAll per 2.5a fix)
  freezePrototypes();

  // 12. start MCP transport (existing)
  const server = buildMcpServer(registry);
  await server.connect(new StdioServerTransport());

  // 13. shutdown hooks (existing + extended)
  attachShutdownHandlers(async () => {
    await loader.shutdownAll();
    await registry.shutdownAll();
    credentialStore.close();                  // ★ NEW: zero parent-side cache
                                              //   (each child's broker.shutdown()
                                              //   zeros its own scoped Map; see §C.5)
  });
}

// Module entry — invoke when this file is the process entry point. The CLI's
// `kuzo serve` command imports `runServer` and skips this branch. The 2.5e parity
// test (scripts/test-install-parity.mjs) boots `node packages/core/dist/server.js`
// directly and relies on this guard.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runServer().catch((err) => {
    process.stderr.write(`kuzo server failed: ${(err as Error).message}\n`);
    process.exit(80);
  });
}
```

**Pinned invariants** (enforced by code order; asserted by the boot-sequence smoke test in §F.1; invariant 5 additionally enforced by the lint rule in §C.9):

1. `collectEnvOverrides()` must execute **before** `scrubProcessEnv()` (otherwise the values are gone before we capture them).
2. `scrubProcessEnv()` must execute **before** `loader.loadAll()` (otherwise plugins / their children see unfiltered `process.env`).
3. `loader.loadAll()` must execute **before** `freezePrototypes()` (preserved from 2.5e A.9 — protects plugin manifest imports from frozen-prototype issues).
4. `credentialStore.close()` must execute **after** `loader.shutdownAll()` (plugins may make final credential reads during shutdown).
5. **No `child_process.fork/spawn/exec/execFile/spawnSync/execSync/execFileSync`** between `ConfigManager` construction (step 2) and `scrubProcessEnv()` (step 7). The existing code base satisfies this — `PluginProcess` only forks on the first `callTool`, which can't fire before `loader.loadAll()` completes. Enforced by ESLint rule scoped to `packages/core/src/server.ts` + `packages/core/src/loader.ts`; only `packages/core/src/plugin-process.ts` is permitted to import from `node:child_process`. See §C.9.
6. `collectDeclaredCredentialEnvNames()` MUST read static `package.json#kuzoPlugin.capabilities` only. No dynamic `import()` of plugin entry modules before step 7 — third-party plugins ship arbitrary top-level code, and importing them pre-scrub voids the scrub guarantee.
7. `KUZO_PASSPHRASE` is scrubbed unconditionally at step 7 regardless of the `doScrub` flag. The kill-switch is for declared credential names only — the passphrase is never exempt.

### C.2 Env-var-first precedence (gh-style)

Within `CredentialSource.get()`: env override wins over store. This mirrors `gh`'s `GH_TOKEN > GITHUB_TOKEN > stored` precedence (research Task 2). The "always use the most-explicit source" rule:

- `op run -- kuzo serve` works out of the box — `op` injects `GITHUB_TOKEN=ghp_xxx` at spawn, `collectEnvOverrides()` picks it up, scrub clears it from `process.env`, the value flows through `CredentialSource` to the plugin's child.
- `KUZO_TOKEN_GITHUB_TOKEN=ghp_xxx kuzo serve` also works — same path.
- A pre-existing keychain entry remains the long-term store; env override is per-invocation.

**No `KUZO_CRED_BROKER=op` flag.** Not needed — env-override-first handles it. The brief's recommended `KUZO_CRED_BROKER` env var is dropped from the spec (acknowledged in the locked decisions). `op run` is the documented pattern; no extra flag.

### C.3 Parent-eager decrypt in the store

`EncryptedCredentialStore.get()` is "lazy with respect to construction" but "eager with respect to plugin loading": the store does not touch the keychain at construction (step 4) — the first `.get()` triggers decryption. In the parent-eager boot model that first `.get()` fires during `loader.loadAll()` at step 10 (specifically, inside `credentialSource.extractForPlugin()` for the first plugin whose required credentials are not satisfied by env overrides), NOT lazily on the first MCP tool call.

```typescript
class EncryptedCredentialStore implements CredentialStore {
  private cache: Map<string, string> | undefined;
  private fileExists: boolean | undefined;

  get(key: string): string | undefined {
    // Fast-path short-circuit: if the file does not exist, never invoke
    // keyProvider.acquireKey() — defends the NullKeyProvider env-override-only
    // mode against accidental keychain prompts. Cached after first check.
    if (this.fileExists === undefined) {
      this.fileExists = existsSync(this.filePath);
    }
    if (!this.fileExists) return undefined;
    return this.loaded().get(key);
  }

  private loaded(): Map<string, string> {
    if (this.cache) return this.cache;
    const raw = readFileSync(this.filePath);
    const map = this.decrypt(raw);            // calls keyProvider.acquireKey() — may
                                              // prompt keychain on macOS first run
    this.cache = map;
    this.auditLogger?.log({
      plugin: "kuzo",
      action: "credential.store_unlocked",
      outcome: "allowed",
      details: { backend: this.keyProvider.id, count: map.size },
    });
    return map;
  }
}
```

**Zero or one unlock per Node lifetime.** Two paths:

1. **Every plugin's required credentials are satisfied by env overrides.** No `.get()` call ever drops into `loaded()`. The keychain is never touched. `acquireKey()` is never called. Zero prompts.
2. **At least one plugin needs a stored credential.** The first `credentialSource.get()` during the first `extractForPlugin()` triggers `loaded()` → `decrypt()` → `keyProvider.acquireKey()` → (one) keychain prompt OR scrypt KDF. The decrypted blob lands in the parent's `cache` Map. Every subsequent `.get()` across all remaining plugins hits the cached Map directly.

**Decrypted values never live in any child process's `EncryptedCredentialStore`.** Each child receives only its scoped per-plugin Map via the IPC handshake (in `plugin-process.ts`'s fork init payload). The child's `DefaultCredentialBroker` is constructed from that Map. The child has no `KeyProvider`, no `EncryptedCredentialStore`, no path to read `credentials.enc`, and no path to talk to the keychain. Compromise of one plugin child cannot read credentials belonging to another plugin.

**Mid-boot consequences:**
- The keychain prompt happens during `loader.loadAll()` — between server-process startup and the MCP transport `connect()`. The MCP client (Claude Code) sees no response on stdio until the prompt is resolved. This is consistent with how 2.5e plugin install already blocks on user input.
- If a child process is later spawned for the first tool call, no further keychain interaction is needed — the child already has its resolved credentials from the IPC handshake.
- If the user runs `kuzo credentials rotate <name>` while the server is running, the parent's `cache` is invalidated via the file-watch + IPC refresh path described in §C.11.

### C.4 Third-party `getClient` factory registration

Brief Tier 3 ask. Today the broker has a hardcoded `clientFactories` map in `credentials.ts` for `github` and `jira`. Open it for third-party plugins — but per **R24 (STRUCTURAL)** the registration entry point moves onto `PluginContext.credentials`, NOT a new `@kuzo-mcp/core/credentials` subpath export.

**Why not a subpath export.** Plugins are forbidden from importing `@kuzo-mcp/core` internals (the brief's constraint #5 + the 2.5e A.9 cross-plugin lint rule). The `@kuzo-mcp/core/credentials` subpath is not in `packages/core/package.json`'s exports map today, and adding it would punch a hole in the boundary specifically for credential code — the riskiest possible place to relax. Plugins already receive a `PluginContext` constructed by the loader and reconstructed in the child; the broker hangs off `PluginContext.credentials`. Putting `registerClientFactory` on the broker keeps everything plugin-touchable behind the existing context boundary.

**`CredentialBroker` interface extension (in `packages/types/src/index.ts`):**

```typescript
export interface CredentialBroker {
  getClient<T>(service: string): T | undefined;
  createAuthenticatedFetch(url: string): typeof fetch;
  getRawCredential(name: string): string | undefined;

  /**
   * Register a factory for THIS plugin's primary service.
   *
   * Constraints (enforced by the broker, which knows the calling plugin's name):
   *   - The plugin must declare `access: "client"` for the service's credentials
   *     in its manifest (otherwise getClient<T>("...") will fail anyway).
   *   - A plugin can only register factories for ITS OWN service. Cross-plugin
   *     overrides (e.g., plugin "foo" registering for service "github") throw.
   *     The "service ↔ plugin" pin is set at broker construction in the loader.
   *   - Idempotent: registering the same (plugin, service) pair twice is a no-op.
   *
   * First-party defaults for "github" and "jira" are pre-loaded into every
   * broker instance at construction. Third-party plugins cannot override them.
   */
  registerClientFactory<T>(
    service: string,
    factory: (config: Map<string, string>, logger: PluginLogger) => T | undefined,
  ): void;
}
```

**Plugin usage from `initialize()`:**

```typescript
async initialize(context: PluginContext) {
  context.credentials.registerClientFactory<MyClient>("my-service", (config, logger) => {
    const token = config.get("MY_TOKEN");
    if (!token) return undefined;
    return new MyClient({ token, logger });
  });
  const client = context.credentials.getClient<MyClient>("my-service");
  if (!client) {
    throw new Error("MY_TOKEN missing — plugin will skip");
  }
  this.client = client;
}
```

Registration must happen synchronously in `initialize()` BEFORE the first `getClient` call. Pre-`initialize` registration via module-top-level side effects is forbidden — the loader's child-side broker construction happens before the plugin's `initialize()` is called, and module-top-level code can't reliably observe `PluginContext` (no global to register against). Documented in §C.8 known gotchas.

**Why this is acceptable security-wise:** the factory runs in the plugin's own process (after the 2.5d isolation split). The factory receives the scoped credential Map and the plugin logger. It returns an object. The plugin code can already do this manually — exposing it as a registered factory just standardizes the pattern and emits the audit event from the broker (`credential.client_created`) instead of from ad-hoc plugin code. Per the IPC audit routing in §C.10, that audit event flows back to the parent's writer.

**The hardcoded factories for `github` and `jira`** continue to exist as defaults — pre-loaded into every broker instance at construction. Third-party plugins can register factories only for OTHER service names. There is no override mechanism for built-in factories.

### C.5 Shutdown scrub (Q15)

Two scrub paths, in two different processes:

**Parent (`server.ts` shutdown handler):**

```typescript
// EncryptedCredentialStore.close() — drops the decrypted cache and zeros
// the master key Buffer. Runs in the PARENT only; children have neither.
close(): void {
  const priorCount = this.cache?.size ?? 0;
  if (this.cache) {
    this.cache.clear();
    this.cache = undefined;
  }
  // Honest: the master key is a Buffer (32 bytes). Buffer.fill(0) actually
  // overwrites the underlying bytes — this part IS a real wipe.
  this.keyProvider.wipeKeyCache?.();
  this.auditLogger?.log({
    plugin: "kuzo",
    action: "credential.store_locked",
    outcome: "allowed",
    details: { priorCount },
  });
}
```

`KeyProvider.wipeKeyCache(): void` is an optional method on the `KeyProvider` interface; implementations that hold a `Buffer` key (`KeychainKeyProvider`, `PassphraseKeyProvider`) call `this.cached?.fill(0); this.cached = undefined`. `NullKeyProvider` / `InMemoryKeyProvider` either no-op or do the equivalent.

**Child (`plugin-host.ts` shutdown handler):**

```typescript
// DefaultCredentialBroker.shutdown() — drops the per-plugin scoped credential
// Map. Runs in the CHILD only; the parent never holds the child's broker. Wired
// per R25: plugin-host calls broker.shutdown() AFTER plugin.shutdown(), before
// process.exit. server.ts shutdown does NOT call broker.shutdown() — there's
// no broker in the parent to shut down.
shutdown(): void {
  const priorCount = this.config.size;
  this.config.clear();
  // Drop registered client factories (no-op for first-party defaults; clears
  // third-party registrations so they cannot be re-invoked post-shutdown).
  this.clientFactories.clear();
  this.clientCache?.clear();
}
```

**Honest zero-fill language (R13).** Three distinct surfaces, three distinct guarantees:

1. **Master key (`Buffer`)** — `Buffer.fill(0)` actually overwrites the 32 bytes in memory. This is a real wipe. The keychain entry on disk is untouched; only the in-memory copy is zeroed.
2. **Plaintext credential Map (parent's `EncryptedCredentialStore.cache`)** — values are `string`. We `Map.clear()` and drop the reference. **We do NOT iterate and overwrite each value with `"\0".repeat(...)`.** V8 strings are immutable + interned; the overwrite assignment creates a fresh string and leaves the original UTF-16 buffer reachable until GC. Pretending otherwise via the `"\0".repeat` dance was theater; the round-3 fix drops it.
3. **Child broker's scoped Map (`config`)** — same story as above. `Map.clear()` only.

The actual security wins from shutdown scrub:
- Heap dumps taken immediately post-shutdown surface fewer reachable strings (the Map reference is gone, so simple traversal misses them — but a determined attacker scanning raw heap pages can still find unreachable strings until GC reclaims them).
- The master-key zero IS protective if the parent process is dumped or coredumped — the wipe removes the only path back to the file's plaintext.

**Out-of-scope future improvement.** Storing credential values as `Buffer` end-to-end (so `Map.clear()` could be preceded by per-buffer `fill(0)`) would require changing `CredentialStore.get(): string | undefined` → `Buffer | undefined` everywhere downstream — broker, plugin-context, every plugin's `getClient` factory. Big refactor across the public plugin API. Filed as an open question (§F.2) for a follow-up phase; out of scope for round 3 / Phase 2.6.

### C.6 Loader changes (single-file surface)

Existing `packages/core/src/loader.ts` line 312:

```typescript
({ config, missing } = this.configManager.extractPluginConfig(
  v2Config.required,
  v2Config.optional,
));
```

Becomes:

```typescript
const credCaps = [
  ...plugin.capabilities.filter(isCredentialCapability),
  ...(plugin.optionalCapabilities ?? []).filter(isCredentialCapability),
];
({ config, missing } = this.credentialSource.extractForPlugin(credCaps));
```

`missing` now only includes credentials with `optional: false` (handled by `extractForPlugin`'s logic — only required caps contribute to `missing`).

**Delete `extractV2Config()`** in loader.ts — `extractForPlugin` does the same work against `CredentialCapability` directly. The function is unused after this swap.

**Keep `extractCredentialCapabilities()` (R29).** Distinct from `extractV2Config`. Lives at `loader.ts:199-203` and is also called at `loader.ts:332` to populate the child-side broker's `capabilities` array when constructing `PluginProcess`. The child's `DefaultCredentialBroker` reconstructs itself in `plugin-host.ts:114` from the `capabilities` array shipped over IPC — without that, the child has no idea what it's allowed to access. `extractCredentialCapabilities` STAYS.

Constructor signature change for `PluginLoader`: new last arg `credentialSource: CredentialSource`. Existing callers in `server.ts` and parity-test fixtures must pass it. ConfigManager stays for non-credential config (`enabled` flags, future settings).

### C.7 `ConfigManager` simplification

Once credential extraction moves to `CredentialSource`, `ConfigManager.extractPluginConfig()` has no remaining callers. Delete the method. `loadDotenv()` stays — it still loads `.env` for non-credential config (`LOG_LEVEL`, eventually `KUZO_HOME` overrides if set there).

`loadDotenv()` is called by `ConfigManager`'s constructor at step 2 of the boot sequence — **before** we read `process.env` for credential overrides at step 5. So `.env`-supplied credentials show up as env overrides automatically. Good.

**Post-migrate `.env` scrub policy (R31).** After `kuzo credentials migrate` succeeds, the `.env` redaction is part of the rewrite (per §B.4 step 3). But what about the case where the user re-creates `.env` post-migrate (intentionally, e.g. for CI parallel-fixture isolation) and puts a credential back?

1. At boot, after `loadDotenv()` populates `process.env` (step 2), and after `collectEnvOverrides()` resolves which env-overrides flow through (step 6), we have enough information to detect "this credential came from .env, not from the shell." Specifically: the `dotenv` library's return value lists each key it set; we cross-reference against `collectEnvOverrides`'s output.
2. Emit a **once-per-boot stderr warning** for each detected credential-name that came from `.env`:
   ```
   [kuzo] WARNING: credential GITHUB_TOKEN was loaded from <path-to-.env>.
                   Run 'kuzo credentials migrate' to move it to encrypted storage.
   ```
3. Do NOT refuse to boot. The user may have a deliberate reason (CI checkout patterns, test fixtures, `.env.test` workflows). The warning is the nudge; the migrate command is the action.
4. Suppressible via `KUZO_NO_MIGRATE_NUDGE=1` for users in deliberate env-override-only mode (CI without keychain — see §F.5).
5. The warning is purely informational — no audit event (the audit log already has `credential.client_created` events that surface what's being used at runtime; doubling up adds noise).

The dotenv load itself doesn't change behavior — `.env` is also where users keep non-secret config like `LOG_LEVEL`. The scrub at step 7 still removes the credential value from `process.env` (it was an env-override match). The `.env` file on disk is unchanged — only the in-process copy is scrubbed.

### C.8 Known gotchas

- **Don't put the scrub inside `loader.loadAll()`.** It must happen at the orchestrating layer (server.ts) so the loader stays agnostic about whether scrub is even desired (test code may want to disable it). The invariant must be visible at the call site.
- **Dotenv loads `.env` AT REQUIRE TIME of `ConfigManager`.** This means `process.env.GITHUB_TOKEN` is set after step 2 of the boot sequence, **before** we collect overrides at step 6. The scrub at step 7 catches it. But: if any code between steps 2 and 7 reads `process.env.GITHUB_TOKEN`, it sees the value. Audit the boot-sequence files in code review — currently nothing does, but it's a regression risk worth flagging.
- **`process.env` is shared across all in-process code.** Scrub affects EVERY module that reads `process.env.GITHUB_TOKEN` after step 7. That's intentional — but if a future feature wants the value, it must go through `CredentialSource.get()`, not `process.env`.
- **Child processes inherit `process.env` AT FORK TIME.** Scrub happens at boot, well before any `PluginProcess` forks. ✓ Enforced by the ESLint rule in §C.9: `node:child_process` is banned in `packages/core/src/server.ts` and `packages/core/src/loader.ts`; only `packages/core/src/plugin-process.ts` may import it. The boot-sequence smoke test asserts `process.env.GITHUB_TOKEN === undefined` in a freshly-forked plugin child as a defense-in-depth complement to the lint rule.
- **Plugin manifest data for the pre-scrub boot step comes from `package.json#kuzoPlugin` only.** Plugin entry modules are never `import()`-ed before scrub. If a plugin's runtime manifest (the `KuzoPluginV2` object exported from its entry) declares a `CredentialCapability` not present in `package.json#kuzoPlugin.capabilities`, the loader skips the plugin with `plugin.failed: manifest_drift` rather than silently widening the scrub list. Plugin authors keep both in sync; the install CLI's verify command surfaces drift.
- **`KUZO_PASSPHRASE` is unconditionally scrubbed**, separate from the declared-env-names list. `KUZO_NO_ENV_SCRUB=1` (kill-switch for dotenv-library debugging) does NOT exempt `KUZO_PASSPHRASE`. The kill-switch is also not a supported production knob — emit a loud `logger.warn` plus a `credential.scrub_disabled` audit event when set.
- **`KUZO_NO_ENV_SCRUB=1` is for dotenv-collision debugging only**, not for production. Emit a loud warning at boot when set.
- **Factory registration happens inside `initialize()`, NOT at module top-level (R24).** Pre-`initialize` registration via module side effects is forbidden — module-top-level code has no `PluginContext` reference and runs before broker construction. Plugins MUST call `context.credentials.registerClientFactory(...)` synchronously inside their `initialize(context)` body BEFORE the first `getClient` call. Cross-plugin registration is rejected (the broker pins each plugin to its own service at construction). Idempotent: same `(plugin, service)` pair registering twice is a no-op.
- **The third-party factory has full access to the scoped config Map.** That's by design — the factory IS plugin-controlled code. The security boundary is "factory cannot escape the plugin's process" (already enforced by 2.5d isolation) + "factory only receives the scoped credentials the plugin declared." Not "factory cannot see raw tokens." The brief's vector 2 is mitigated by the broker shape on first-party services; for third-party, the user must trust the plugin code (via Sigstore + consent) — same as for any installed npm package.

### C.9 Lint rule — `child_process` ban in pre-scrub paths

Invariant 5 from §C.1 ("no `child_process.fork/spawn/exec` between `ConfigManager` construction and scrub") is enforced by an ESLint `no-restricted-imports` + `no-restricted-syntax` rule pair. The rule lives in `eslint.config.js` alongside the cross-plugin import ban from 2.5e A.9.

```javascript
// eslint.config.js — new block
{
  files: [
    "packages/core/src/server.ts",
    "packages/core/src/loader.ts",
  ],
  rules: {
    "no-restricted-imports": ["error", {
      paths: [
        {
          name: "node:child_process",
          message: "child_process.fork/spawn/exec/execFile/spawnSync/execSync/execFileSync MUST NOT be invoked in pre-scrub paths. Plugin children are spawned only via packages/core/src/plugin-process.ts after scrub completes. See spec/credentials-spec.md §C.1 invariant 5 + §C.9.",
        },
        {
          name: "child_process",
          message: "Use 'node:child_process' for built-in modules. (And don't import it from server.ts or loader.ts — see §C.9.)",
        },
      ],
    }],
    "no-restricted-syntax": ["error", {
      selector: "CallExpression[callee.object.name='childProcess']",
      message: "child_process methods are banned in this file. See §C.9.",
    }],
  },
},
```

Scoped via `files:` so `packages/core/src/plugin-process.ts` (the only legitimate child-process consumer) keeps its existing imports unmolested.

**Acceptance criterion (§F.1):** Synthetic test plants `import { fork } from "node:child_process";` at the top of `packages/core/src/server.ts`, runs `pnpm lint`, asserts the rule fires red.

**Why a lint rule rather than runtime detection.** Runtime detection (e.g., monkey-patching `child_process.fork` to throw if called pre-scrub) would have to live in the same code path the rule defends, creating a chicken-and-egg pattern. ESLint catches the regression at PR time, before the bad code ever runs.

**What this does NOT cover.** Third-party npm dependencies invoked from `server.ts` / `loader.ts` that internally spawn children pre-scrub. The dependency surface for those two files is tightly bounded today (mostly `@modelcontextprotocol/sdk`, `@kuzo-mcp/*`, Node built-ins), but a future `npm install` that pulls in a heavyweight transitive dep with fork-on-import behavior would bypass the lint rule. Mitigation: dependency review at PR time for any new `dependencies` entry in `packages/core/package.json`, plus the §F.1 boot-sequence smoke test that asserts `process.env.GITHUB_TOKEN === undefined` in a forked child.

### C.10 Plugin-host audit emissions route through IPC

The 2.5d isolation split moved the `DefaultCredentialBroker` into the plugin child process. Today every plugin child runs `appendFileSync(~/.kuzo/audit.log)` directly via `plugin-host.ts:113`'s `AuditLogger`. The `plugin` field in each event is whatever the caller supplies — no PID check, no identity verification. Phase 2.6 adds high-trust write-side events (`credential.set`, `.rotated`, `.migrated`, `.wiped`, `.tested`) that are byte-indistinguishable from forgeries if a compromised plugin child writes its own line claiming `plugin: "kuzo"`. Threat vector 7 (audit trail integrity under plugin compromise) is silently broken unless this is fixed.

**Resolution (R16):** re-architect audit emission so the parent owns the file writer. Children flow through IPC.

**Three writer surfaces, three trust boundaries:**

1. **CLI commands (`kuzo credentials *`, `kuzo plugins *`, etc.)** — write to `audit.log` directly. Trust boundary is the interactive user.
2. **`runServer()` parent (boot + lifecycle + store + parent-owned PassphraseKeyProvider)** — writes directly. Trust boundary is the user (same process, no plugin-controlled code yet).
3. **Plugin host (every child)** — does NOT write to `audit.log` directly. Sends an IPC notification to the parent: `{type: "audit", event: {...}}`. Parent receives, validates, and writes.

**Parent-side IPC receiver protocol:**

```typescript
// packages/core/src/plugin-process.ts — new IPC handler
// Each PluginProcess knows its declared plugin name (set at construction).

// Allowlist of audit actions a plugin child is allowed to emit. These are the
// read-side events that the in-child DefaultCredentialBroker legitimately
// produces. Every other AuditAction variant (the write-side events from §B.7
// — credential.set/.rotated/.migrated/.wiped/.tested/.scrub_disabled/etc.)
// is parent-only and must NOT appear in child IPC traffic.
const CHILD_PERMITTED_AUDIT_ACTIONS = new Set<AuditAction>([
  "credential.client_created",
  "credential.raw_access",
  "credential.raw_denied",
  "credential.fetch_created",
]);

private handleAuditEvent(event: AuditEvent): void {
  // 1. Always stamp PID from child — overwrites any caller-supplied value.
  //    Also stamp source: "child" so audit consumers can reason about the
  //    write boundary even on legitimate emissions.
  const stampedEvent: AuditEvent = {
    ...event,
    pid: this.childPid,
    source: "child",
  };

  // 2. Validate plugin field matches the child's declared identity (R16).
  if (stampedEvent.plugin !== this.declaredPluginName) {
    this.auditLogger.log({
      plugin: "kuzo",
      action: "audit.forged_plugin_field",
      outcome: "denied",
      source: "parent",
      details: {
        claimed_plugin: stampedEvent.plugin,
        actual_plugin: this.declaredPluginName,
        child_pid: this.childPid,
        attempted_action: stampedEvent.action,
      },
    });
    return;
  }

  // 3. Validate action is in the child-permitted allowlist (R16 advisory).
  //    Closes the action-class impersonation vector: a compromised child
  //    correctly claiming its own plugin identity can still try to emit
  //    write-side events (credential.set / .rotated / .migrated / .wiped /
  //    .tested / .scrub_disabled) and have them pollute the audit trail
  //    indistinguishably from parent-CLI emissions. The allowlist refuses
  //    those at the trust boundary.
  if (!CHILD_PERMITTED_AUDIT_ACTIONS.has(stampedEvent.action)) {
    this.auditLogger.log({
      plugin: "kuzo",
      action: "audit.forged_action",
      outcome: "denied",
      source: "parent",
      details: {
        plugin: this.declaredPluginName,
        child_pid: this.childPid,
        attempted_action: stampedEvent.action,
        permitted: Array.from(CHILD_PERMITTED_AUDIT_ACTIONS),
      },
    });
    return;
  }

  // 4. Trusted: write through the parent's AuditLogger with source="child".
  this.auditLogger.log(stampedEvent);
}
```

**Action-class allowlist rationale.** Without step 3, R16's `plugin` validation closes cross-plugin impersonation (github plugin can't claim to be jira) but leaves action-class impersonation open: the github plugin, legitimately stamped as `plugin: "github"`, could emit `action: "credential.rotated"` and pollute the audit trail with a fake "user rotated github creds at 14:32" entry. Audit reviewers reasoning about "who initiated this write" can't distinguish parent-CLI emissions from child IPC emissions because the action set is supposed to be partitioned by trust boundary. The allowlist makes the partition explicit and machine-enforced at the IPC boundary.

**Permitted child actions are exactly the read-side broker events** that the in-child `DefaultCredentialBroker` legitimately produces during plugin tool execution:

- `credential.client_created` — `broker.getClient<T>()` returned a constructed client.
- `credential.raw_access` — `broker.getRawCredential()` returned a value.
- `credential.raw_denied` — `broker.getRawCredential()` denied (no capability declared).
- `credential.fetch_created` — `broker.createAuthenticatedFetch()` was called.

Every other audit action is parent-only:

| Action | Producer | Permitted from child? |
|---|---|---|
| `credential.client_created` / `.raw_access` / `.raw_denied` / `.fetch_created` | child broker | ✓ |
| `credential.store_unlocked` / `.store_locked` | parent store | ✗ |
| `credential.set` / `.deleted` / `.rotated` / `.migrated` / `.migration_partial` / `.wiped` / `.tested` | parent CLI | ✗ |
| `credential.passphrase_consumed` | parent `PassphraseKeyProvider` | ✗ |
| `credential.scrub_disabled` | parent `runServer()` boot | ✗ |
| `credential.refreshed_in_flight` | parent file-watch handler | ✗ |
| `audit.forged_plugin_field` / `audit.forged_action` | parent IPC validator | ✗ |
| `consent.*` / `plugin.*` (existing 2.5c/2.5e) | parent CLI / loader | ✗ |

**`source: "parent" | "child"` field** is also stamped on every entry at write time. Audit consumers reading `audit.log` can filter by source to reason about trust without needing to know the allowlist. Add `source` to the `AuditEvent` shape in `packages/core/src/audit.ts`. Existing entries (pre-2.6) get `source` omitted; consumers treat missing as `"parent"` (the only writer pre-2.6 was the parent).

**Allowlist drift defense — encode the partition as code (round-2 advisory).** The table above is the source of truth, but its in-spec form drifts the moment a developer adds an `AuditAction` variant without also classifying it parent-only or child-permitted. Mitigation: codify the partition in `packages/core/src/audit-partition.ts` as a TypeScript discriminated record that exhaustiveness-checks every variant of the `AuditAction` union. Adding a new variant without classifying it is a TYPE error, not a runtime surprise.

```typescript
// packages/core/src/audit-partition.ts
import type { AuditAction } from "./audit.js";

/**
 * Exhaustive trust-partition of every AuditAction variant. New variants
 * MUST be added here at the same time they're added to the union, or
 * TypeScript will fail to compile this file.
 */
export const AUDIT_ACTION_PARTITION: Record<AuditAction, "parent-only" | "child-permitted"> = {
  // child-permitted: read-side broker emissions in plugin-host
  "credential.client_created": "child-permitted",
  "credential.raw_access":     "child-permitted",
  "credential.raw_denied":     "child-permitted",
  "credential.fetch_created":  "child-permitted",

  // parent-only: lifecycle / CLI / boot / parent-owned subsystems
  "credential.store_unlocked":        "parent-only",
  "credential.store_locked":          "parent-only",
  "credential.set":                   "parent-only",
  "credential.deleted":               "parent-only",
  "credential.rotated":               "parent-only",
  "credential.migrated":              "parent-only",
  "credential.migration_partial":     "parent-only",
  "credential.passphrase_consumed":   "parent-only",
  "credential.scrub_disabled":        "parent-only",
  "credential.wiped":                 "parent-only",
  "credential.tested":                "parent-only",
  "credential.refreshed_in_flight":   "parent-only",
  "audit.forged_plugin_field":        "parent-only",
  "audit.forged_action":              "parent-only",
  // ... plus existing 2.5c/2.5e consent.* / plugin.* entries (all parent-only)
};

// Derived at module load — no runtime cost, single source of truth.
export const CHILD_PERMITTED_AUDIT_ACTIONS: ReadonlySet<AuditAction> = new Set(
  (Object.entries(AUDIT_ACTION_PARTITION) as [AuditAction, string][])
    .filter(([, scope]) => scope === "child-permitted")
    .map(([action]) => action),
);
```

§C.10's IPC handler imports `CHILD_PERMITTED_AUDIT_ACTIONS` from this module — the in-handler `Set` literal in the §C.10 example code disappears. Acceptance criterion (§F.1): a unit test plants a new `AuditAction` variant in a fixture without updating `AUDIT_ACTION_PARTITION` and asserts the project fails `tsc --noEmit` with an "Property 'foo.bar' is missing in type" error before the test even runs.

**Acceptance criterion update (§F.1).** Extend the audit-forgery synthetic test:

1. Existing: plant a child emitting `plugin: "kuzo"` → assert `audit.forged_plugin_field` lands; the impersonated entry is NOT written.
2. NEW: plant a child correctly claiming `plugin: "github"` but emitting `action: "credential.rotated"` → assert `audit.forged_action` lands with `details.attempted_action === "credential.rotated"` and `details.permitted` listing exactly the four read-side events; the impersonated entry is NOT written.
3. NEW: plant a child legitimately emitting `action: "credential.client_created"` → assert it lands with `source: "child"` and the child's PID.
4. NEW: TypeScript exhaustiveness — drop the `"credential.client_created"` entry from `AUDIT_ACTION_PARTITION` and assert `tsc --noEmit` fails red.

**Child-side IPC sender protocol:**

```typescript
// packages/core/src/plugin-host.ts — replace direct appendFileSync usage
// with an IPC-backed AuditLogger proxy.
class IpcAuditLogger implements AuditLogger {
  constructor(private readonly ipc: IpcChannel) {}
  log(event: Omit<AuditEvent, "pid">): void {
    this.ipc.notify("audit", { event });
  }
  // Query method is not exposed in children — audit reads only happen in the parent CLI.
  query(): never {
    throw new Error("audit.query() is parent-only; child plugins cannot read the audit log");
  }
}
```

The child's `DefaultCredentialBroker` is constructed with the `IpcAuditLogger` instead of the file-backed one. Every existing emission path (`credential.client_created`, `.raw_access`, `.raw_denied`, `.fetch_created`) flows through IPC transparently.

**File-writer-monopoly invariant:** `packages/core/src/audit.ts` is imported by exactly two paths in the runtime:
1. `packages/core/src/server.ts` (parent process) — constructs the real file-backed `AuditLogger`.
2. `packages/cli/src/commands/*` (parent process, CLI invocations) — constructs the real file-backed `AuditLogger`.

`packages/core/src/plugin-host.ts` (child process) MUST NOT import the file-backed `AuditLogger`. It only imports the `IpcAuditLogger` proxy. Enforced by an ESLint rule scoped to `plugin-host.ts` that bans the `appendFile`/`appendFileSync` API surface and the `audit.ts` `AuditLogger` class export specifically — see §C.9 for the pattern.

**Acceptance criterion (§F.1):** Synthetic test plants a malicious plugin that emits an audit event from its `initialize()` claiming `plugin: "kuzo"` (impersonating core). Test asserts the emission is logged as `audit.forged_plugin_field` with the real child PID + the impersonated plugin name in `details.claimed_plugin`, NOT as the impersonated `plugin: "kuzo"` entry. Test then asserts `grep -c 'plugin.*kuzo' audit.log` for the synthesized line is zero.

**Implementation order.** The IPC routing MUST land before any of the new write-side audit events from §B.7 (`credential.set` / `.rotated` / `.migrated` / `.wiped` / `.tested`) ship to production, because every one of those events compounds the impersonation surface. Build-order tweak: Theme 4 (audit IPC) lands first in the §0 cross-cutting build order's Part C wave, before the §C.4-C.6 write-side audit events.

### C.11 Rotation cache invalidation — file watch + IPC refresh (R34)

`kuzo credentials rotate GITHUB_TOKEN` writes to disk. The running `kuzo serve` parent's `EncryptedCredentialStore.cache` still holds the old decrypted value. Plugin children also hold the old value (they got their resolved Map at fork time). Tool calls keep using the stale token until the user restarts Claude Code — which they didn't do, because rotating a token shouldn't require a full restart.

**Solution:** the parent watches the credentials file and propagates refreshes to children via IPC.

**Parent side (`runServer()`):**

```typescript
// After step 10 (loader.loadAll), once we know the first store unlock happened:
let watcher: fs.FSWatcher | undefined;
if (credentialStore.isUnlocked()) {
  watcher = fs.watch(credentialsFilePath(), (eventType) => {
    if (eventType !== "change" && eventType !== "rename") return;
    handleCredentialFileChange().catch((err) =>
      logger.error(`credential refresh failed: ${err}`),
    );
  });
}

async function handleCredentialFileChange() {
  // Debounce: rotate is a tmp+rename, which fires multiple events.
  await debounce(250);
  credentialStore.reload();      // re-decrypts; bumps cache generation
  // For each running PluginProcess, recompute the per-plugin Map.
  for (const proc of loader.runningProcesses()) {
    const refreshedConfig = credentialSource.extractForPlugin(
      proc.declaredCapabilities,
    );
    proc.notify("credential.refresh", { config: refreshedConfig.config });
  }
  auditLogger.log({
    plugin: "kuzo",
    action: "credential.refreshed_in_flight",
    outcome: "allowed",
    details: { count_refreshed: loader.runningProcesses().length },
  });
}
```

**Child side (`plugin-host.ts`):**

```typescript
// New IPC handler in plugin-host
ipc.on("credential.refresh", ({ config }: { config: Record<string, string> }) => {
  broker.replaceConfigAtomically(new Map(Object.entries(config)));
  logger.info("credentials refreshed from parent");
});
```

`DefaultCredentialBroker.replaceConfigAtomically(newConfig)` swaps the internal Map. The next `getClient(...)` call uses the new value. Already-constructed clients in `clientCache` (e.g., a long-lived Octokit instance with the old token in its `auth` header) are NOT automatically rotated — the cache is invalidated on the next `getClient` call:

```typescript
replaceConfigAtomically(newConfig: Map<string, string>): void {
  this.config = newConfig;
  this.clientCache.clear();  // force-rebuild clients on next getClient
}
```

**Tradeoff (R34 design note).** A long-running plugin that constructed its API client once at `initialize()` and stashed it in plugin-level state (NOT going through `broker.getClient` every time) will continue to use the old token until that plugin is restarted. We can't reach into arbitrary plugin state. The cache-replacement is a **partial** mitigation, not a complete one. Document in §F.4:

> **Rotation propagates to running plugins via file-watch + IPC. However, plugins that have constructed an API client at `initialize()` time and stashed it in plugin-level state may continue to use the prior token until the client is reconstructed. Restarting Claude Code is the only fully-reliable way to ensure rotation takes effect across every plugin.**

The first-party plugins (`github`, `jira`) go through `broker.getClient` on every tool-call → their clients ARE invalidated on refresh. Third-party plugins are responsible for following the same pattern; the §C.4 third-party factory documentation calls this out.

**Why we still do the partial mitigation.** Daily-use case: developer rotates `GITHUB_TOKEN` because they got a notification email. The first-party github plugin picks up the new token on the next tool call without any user action. Better UX than "restart Claude Code." Acceptance criterion (§F.1): smoke test rotates a credential, verifies the next first-party tool call uses the new token without restart.

**Edge case: NullKeyProvider mode.** The store never unlocks, so `credentialStore.isUnlocked()` is `false` and the watcher is never installed. Rotation in NullKeyProvider mode is a no-op (the user is in env-override-only territory; "rotation" is "restart with a new env var"). Documented.

---

## Part D — MCP server entry

> A friendly `kuzo serve` bin in `@kuzo-mcp/cli` that wraps `runServer()` from `@kuzo-mcp/core`. The canonical `~/.claude/settings.json` block becomes secret-free.

### D.0 Scope

**In:** new `serve` subcommand under `@kuzo-mcp/cli`, the `runServer()` export contract, the canonical settings.json shape, first-run UX when no credentials are configured.

**Out:** the boot sequence body (Part C), the credential store (Part A).

### D.1 `kuzo serve` command surface

New file `packages/cli/src/commands/serve.ts`:

```typescript
import { Command } from "commander";

export const serveCommand = new Command("serve")
  .description("Run the kuzo MCP server (stdio transport)")
  .option(
    "--no-scrub",
    "Skip process.env scrubbing (debug only — plugin children inherit credential env vars)",
  )
  .action(async (options: { scrub: boolean }) => {
    const { runServer } = await import("@kuzo-mcp/core/server");
    try {
      await runServer({ scrub: options.scrub });
    } catch (err) {
      process.stderr.write(`kuzo serve failed: ${(err as Error).message}\n`);
      process.exit(80); // E_SERVER_BOOT_FAILED — see §B.10 (moved from 70 per R44)
    }
  });
```

Wire into `packages/cli/src/index.ts`:

```typescript
program.addCommand(serveCommand);
```

`packages/cli/package.json` `bin` field is unchanged — the existing `kuzo` bin gains the `serve` subcommand. No new binary file.

Add a new subpath export to `@kuzo-mcp/core`:

```jsonc
// packages/core/package.json
{
  "exports": {
    ".": "./dist/server.js",
    "./server": "./dist/server.js",   // ← exports runServer
    // ... existing
  }
}
```

(The default export of `packages/core` is currently the server entry-point script; the new subpath gives the CLI a stable import target without depending on file-eval side effects.)

**Strict core-dependency pin in `@kuzo-mcp/cli` (R30).** `kuzo serve` does `await import("@kuzo-mcp/core/server")`. In `npm install -g @kuzo-mcp/cli` mode, the CLI's `node_modules/@kuzo-mcp/core` is resolved. If the bundled core is older than the CLI expects, `runServer` may not exist or have an incompatible signature. Mitigation:

1. `packages/cli/package.json` declares `"@kuzo-mcp/core": "X.Y.Z"` (exact pin, no caret) at publish time. The changesets `linked: [["@kuzo-mcp/types","@kuzo-mcp/core"]]` rule doesn't extend to cli, so the cli's core dep is manually kept at-or-near the just-released core version. The source declaration is `workspace:^`; at publish, changesets resolves it to `^X.Y.Z` — for the credentials release, we pin tighter via the changeset's `dependencies` override to `X.Y.Z` exactly.
2. Acceptance criterion (§F.1): after `npm install -g @kuzo-mcp/cli@0.1.0`, `kuzo serve --version` prints both the cli version AND the resolved-core version. CI smoke test verifies they match the published manifest.

Document in §D.5 known gotchas.

### D.2 Canonical `~/.claude/settings.json` block

Before 2.6:

```json
{
  "mcpServers": {
    "kuzo": {
      "command": "node",
      "args": ["/Users/sean/.kuzo/plugins/cli/current/pkg/dist/index.js", "serve"],
      "env": {
        "GITHUB_TOKEN": "ghp_xxx",
        "JIRA_API_TOKEN": "xxx",
        "JIRA_HOST": "kuzo.atlassian.net",
        "JIRA_EMAIL": "..."
      }
    }
  }
}
```

After 2.6:

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

The `kuzo` binary is on `$PATH` after `npm install -g @kuzo-mcp/cli` (or via `pnpm dlx`, etc.). Credentials are read from the keychain-backed store. No secrets in the settings file.

If the user prefers per-launch env override (e.g., `op run` integration), the `env: {}` block can carry `KUZO_TOKEN_*` entries — but the spec recommends the keychain path as the canonical default.

Document this in `README.md` as part of the Part F doc updates. `kuzo credentials migrate` walks users from the old block to the new one.

### D.3 First-run UX (no credentials configured)

When a plugin's `loader.loadAll()` cannot resolve a required credential (neither env override nor store has it), the existing behavior is "plugin.skipped: missing required config" audit + plugin not loaded. That continues.

**New affordance:** the loader collects skipped plugins by missing-credential and emits a single summary line at server-ready time:

```
[kuzo] ready — 2 plugins loaded, 1 skipped
[kuzo] git-context: OK
[kuzo] github: OK
[kuzo] jira: SKIPPED — missing credentials (JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN)
[kuzo] Run `kuzo credentials set <name>` to configure.
```

Stderr only (MCP stdio reserves stdout for the protocol).

For a brand-new install with **zero** credentials configured (first `kuzo serve` after install), the message reads:

```
[kuzo] No credentials configured. Plugins requiring credentials will be skipped.
[kuzo] To configure: `kuzo credentials set GITHUB_TOKEN` (or `kuzo credentials migrate` to import from existing config).
```

No interactive prompt at server start — MCP server is non-interactive. The user must invoke `kuzo credentials set ...` from a terminal.

**Upgrade-detection banner (R35).** Users who upgrade from 0.0.2 → 0.1.0 will keep `~/.claude/settings.json` env-block credentials working seamlessly (env overrides win over the empty store; everything keeps running). But they get no nudge to migrate. At `runServer()` ready-time, emit a single stderr banner when BOTH conditions hold:

1. `collectEnvOverrides()` returned ≥1 known credential name FROM `process.env` (sourced from the user's shell OR `~/.claude/settings.json` env block), AND
2. The store has zero stored credentials (`credentialStore.size === 0`, where `.size` short-circuits the file-not-found check without unlocking — Map.size on an empty cache vs. file-existence check).

Banner:
```
[kuzo] Detected unencrypted credentials in your environment.
       Run 'kuzo credentials migrate' to move them to the encrypted store.
```

Emits once per `runServer()` invocation. Suppressible via `KUZO_NO_MIGRATE_NUDGE=1` for users who deliberately use env-override-only (CI / 1Password `op run` / etc. — see §F.5). Same suppression flag as the boot-time `.env` warning in §C.7 (R31); two surfaces, one knob.

### D.4 `runServer()` lifecycle (full sequence)

Already specified in §C.1. Restated as a checklist for D-acceptance:

1. **Install exit guard** — no SIGINT/SIGTERM handlers swallowed.
2. **Load `.env`** via `ConfigManager` — non-credential config available.
3. **Open consent/audit/credential store** — credential store is lazy (no decrypt yet).
4. **Collect env overrides** — `process.env.GITHUB_TOKEN` etc. captured into `envOverrides`.
5. **Scrub `process.env`** — captured keys deleted.
6. **Build `CredentialSource`** — env-override-first lookup ready.
7. **Load plugins** — `loader.loadAll()` constructs `PluginProcess` instances; **no plugin child forked yet** (lazy). For each plugin, `credentialSource.extractForPlugin()` resolves declared credentials: env-override hits return immediately; the FIRST `.get()` that drops into the encrypted store triggers `keyProvider.acquireKey()` → keychain prompt OR scrypt KDF (one event, parent-side cache fills). If every plugin's required credentials come from env overrides, the keychain is never touched. The per-plugin resolved Map ships to the child via IPC; child has no `KeyProvider`.
8. **Freeze prototypes** — per 2.5a; protects post-load runtime.
9. **Connect MCP transport** — server ready.
10. **On SIGINT/SIGTERM**: graceful shutdown — `loader.shutdownAll()` (closes plugin children), `registry.shutdownAll()`, `credentialStore.close()` (zeroes cache).

### D.5 Known gotchas

- **`kuzo` bin must be on `$PATH`.** For `npm install -g`, `pnpm add -g`, or `pnpm dlx` users this is automatic. For local-dev (`pnpm install` in repo), `packages/cli/dist/index.js` is the bin target; the user invokes via `pnpm exec kuzo serve` or `./node_modules/.bin/kuzo serve`. Document both. Claude.app's settings.json typically uses `command: "kuzo"` for global installs; the local-dev pattern is `command: "node", args: ["/path/to/cli/dist/index.js", "serve"]`.
- **Module resolution** — `await import("@kuzo-mcp/core/server")` in `serve.ts` must resolve the runtime-installed `@kuzo-mcp/core` package. With pnpm workspaces, that's automatic in dev (symlinked); installed-mode hits the user's `~/.kuzo/plugins/<name>/node_modules/@kuzo-mcp/core/` via the existing resolver. Verify with the parity test.
- **`--no-scrub` is debug-only.** Emit `process.stderr.write("WARNING: scrub disabled\n")` and an audit `credential.scrub_disabled` event on use. CI must reject `--no-scrub` in release-build smoke tests.
- **Top-level `await import` cost.** The `kuzo serve` entry point dynamic-imports `@kuzo-mcp/core/server` so the CLI binary doesn't pay the core's startup cost for `kuzo credentials list` etc. Static-imported `@kuzo-mcp/core/server` would force the full server module graph on every CLI invocation. Stick with dynamic import.
- **`runServer()` may throw before MCP connect.** Catch in `serveCommand.action` and exit non-zero with a friendly message (path 80 = `E_SERVER_BOOT_FAILED`; see §B.10). If it throws **after** MCP connect, the exit guard handles it.
- **Two boot entry points: `kuzo serve` (CLI) AND direct `node packages/core/dist/server.js`.** Both reach the same `runServer()`. The CLI imports `runServer` from `@kuzo-mcp/core/server` and calls it; the direct-node path uses the `if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)` self-invocation guard at the bottom of `server.ts`. The 2.5e parity test (`scripts/test-install-parity.mjs:115-119`) uses the direct-node path and must keep working — DO NOT remove the self-invocation guard when refactoring the top-level `main()` into the exported `runServer()`. Verified in §F.1 acceptance: parity test continues to pass via the guard.

---

## Part E — Directory contract

> Introduce `KUZO_HOME` as the single env override for "where Kuzo keeps its state." Refactor existing scattered `~/.kuzo` references to a shared path helper. Migration plan for existing users.

### E.0 Scope

**In:** new `KUZO_HOME` env var, `packages/core/src/paths.ts` shared helper, updates to `consent.ts` / `audit.ts` / new credentials store / plugins paths.ts, keychain service/account naming, migration of existing files.

**Out:** the actual credential file format (Part A), command-surface paths (Part B).

### E.1 `KUZO_HOME` env override

Default: `~/.kuzo/`.
Precedence:

| Path | Env override | Falls back to |
|---|---|---|
| Plugins root | `KUZO_PLUGINS_DIR` | `${KUZO_HOME}/plugins` → `~/.kuzo/plugins` |
| `credentials.enc` | (none) | `${KUZO_HOME}/credentials.enc` → `~/.kuzo/credentials.enc` |
| `consent.json` | (none) | `${KUZO_HOME}/consent.json` → `~/.kuzo/consent.json` |
| `audit.log` | (none) | `${KUZO_HOME}/audit.log` → `~/.kuzo/audit.log` |
| `tuf-cache/` | (none) | `${KUZO_HOME}/tuf-cache` → `~/.kuzo/tuf-cache` |
| `attestations-cache/` | (none) | `${KUZO_HOME}/attestations-cache` → `~/.kuzo/attestations-cache` |
| `.lock` (shared write-op lock) | (none) | `${KUZO_HOME}/.lock` → `~/.kuzo/.lock` |

`KUZO_PLUGINS_DIR` retains precedence over `KUZO_HOME` for the plugins root — preserves the 2.5e parity test, which passes a tmpdir for `KUZO_PLUGINS_DIR` only and assumes the home dir's other files (consent, audit, tuf) are also redirected via `HOME`. Document this nuance.

### E.2 Shared `packages/core/src/paths.ts`

New file:

```typescript
import { homedir } from "node:os";
import { join } from "node:path";

export function kuzoHome(): string {
  return process.env["KUZO_HOME"] ?? join(homedir(), ".kuzo");
}

export function pluginsRoot(): string {
  return process.env["KUZO_PLUGINS_DIR"] ?? join(kuzoHome(), "plugins");
}

export function credentialsFilePath(): string {
  return join(kuzoHome(), "credentials.enc");
}

export function consentFilePath(): string {
  return join(kuzoHome(), "consent.json");
}

export function auditFilePath(): string {
  return join(kuzoHome(), "audit.log");
}

export function tufCacheDir(): string {
  return join(kuzoHome(), "tuf-cache");
}

export function attestationsCacheDir(): string {
  return join(kuzoHome(), "attestations-cache");
}

export function kuzoHomeLockPath(): string {
  return join(kuzoHome(), ".lock");
}
```

Export subpath from `@kuzo-mcp/core/package.json`:

```jsonc
{
  "exports": {
    "./paths": "./dist/paths.js",
    // ...
  }
}
```

**Refactors required (R26 — complete inventory of every `homedir() + ".kuzo"` site):**

| Site | Current | After refactor |
|---|---|---|
| `packages/core/src/consent.ts` constructor default | `options.consentDir ?? join(homedir(), ".kuzo")` | Drops `.kuzo` inline; default delegates to `kuzoHome()`. The constructor still accepts an override for test injection. Server.ts always passes `kuzoHome()` explicitly. |
| `packages/core/src/audit.ts` constructor default | `options.logDir ?? join(homedir(), ".kuzo")` | Same pattern as consent. |
| `packages/cli/src/commands/plugins/paths.ts` | local `kuzoHome` helper | Re-exports `pluginsRoot()` and `kuzoHome()` from `@kuzo-mcp/core/paths`. Existing CLI-internal function names preserved for backwards-compat across the codebase. |
| `packages/core/src/provenance/verify.ts` TUF cache path build | `process.env.HOME + ".kuzo/tuf-cache"` (or similar) | Uses `tufCacheDir()` from `@kuzo-mcp/core/paths`. |
| `packages/core/src/plugin-resolver.ts:71` | `process.env["KUZO_PLUGINS_DIR"] ?? join(homedir(), ".kuzo", "plugins")` | Calls `pluginsRoot()` — preserves the `KUZO_PLUGINS_DIR` precedence (resolver-internal env override remains the canonical way to scope plugins for parity tests). |
| `packages/core/src/plugin-process.ts:161` Node permission flag | `--allow-fs-read=${pluginFsPath},${homedir()}/.kuzo/` | `--allow-fs-read=${pluginFsPath},${kuzoHome()}` — uses the shared helper to respect `KUZO_HOME` overrides for Node 22's experimental Permission Model when `KUZO_NODE_PERMISSIONS=true`. |
| `packages/cli/src/commands/plugins/refresh-trust-root.ts:34` | local `kuzoHome` constant shadowing the future helper | Removes the local shadow; imports `kuzoHome()` directly. |

**Acceptance (§F.1):** `git grep -nE 'homedir\(\).*\.kuzo|\.kuzo.*homedir\(\)'` across the entire codebase returns ZERO matches outside `packages/core/src/paths.ts`. Lint rule (in the same `eslint.config.js` block as §C.9): `no-restricted-syntax` matching `CallExpression[callee.name='homedir']` followed by a `.kuzo` string literal in any package other than `packages/core/src/paths.ts` — fires red on any drift.

No behavior change at default settings. Functional tests catch the refactor: parity test + provenance smoke must stay green.

### E.3 Migration of existing users

Most users will have `~/.kuzo/` populated with `consent.json`, `audit.log`, `tuf-cache/`, `attestations-cache/`, `plugins/`. After 2.6:

- **If `KUZO_HOME` is unset**: nothing changes. Defaults still resolve to `~/.kuzo/`. ✓
- **If `KUZO_HOME` is set** (new): the user explicitly moved their state. We expect them to copy or recreate the existing files. We do NOT auto-copy from `~/.kuzo/` to `$KUZO_HOME` — that's surprise mutation. Document the migration as a one-liner: `mv ~/.kuzo ~/some/other/dir && export KUZO_HOME=~/some/other/dir`.

The `credentials.enc` file is new in 2.6 — no migration of existing data needed; `kuzo credentials migrate` is the import command, not a path-migration command.

### E.4 Keychain service/account naming

- **Service:** `kuzo-mcp` (consistent across macOS Keychain, Linux Secret Service, Windows Credential Manager).
- **Account:** `master-key`.
- **Value:** base64-encoded AES-256 master key (44 chars including padding).

Inspect on each platform:

- macOS: `security find-generic-password -s "kuzo-mcp" -a "master-key" -w`
- Linux: `secret-tool lookup service kuzo-mcp account master-key`
- Windows: Credential Manager → search "kuzo-mcp"

These should all return the same base64 string. If they don't, the user has a multi-platform sync issue — out of scope (single-machine assumption).

**Future credential-account names (deferred):** if Q11 (multi-account) ships, accounts could become `master-key`, `master-key:work`, `master-key:personal`. Single-entry-for-now keeps it clean.

### E.5 Known gotchas

- **`homedir()` returns `/root` for daemon-launched processes on Linux** that aren't in a user session. Document that `KUZO_HOME` must be set explicitly for system-daemon launches. (Not a common kuzo deployment; mentioned for completeness.)
- **`pnpm dlx`'s `HOME`** matches the calling user's `HOME` — no special handling needed.
- **Existing parity test uses `KUZO_PLUGINS_DIR`** to redirect just the plugins tree to tmpdir + a custom `HOME` for the rest. Keep this. After 2.6, the parity test additionally needs to override `KUZO_HOME` OR rely on the custom-`HOME` redirect for the new `credentials.enc` location. Recommend: extend the parity test to set `KUZO_HOME=$WORK/kuzo-home` explicitly — clearer than relying on `HOME` indirection.
- **Parity test must set `KUZO_PASSPHRASE` + `KUZO_HOME` for 2.6 (R38).** `scripts/test-install-parity.mjs` boots `runServer()`. After 2.6, the boot path constructs `KeychainKeyProvider` by default. The constructor is inert (R5), so step 4 doesn't prompt. BUT — if any plugin loaded in the parity test declares a `CredentialCapability` that isn't satisfied by an env override, the first `extractForPlugin` triggers `acquireKey()` → keychain prompt on macOS local dev OR throws in CI (no keychain daemon). Fix: the parity-test fixture sets:
  ```bash
  export KUZO_PASSPHRASE="parity-test-not-secret"
  export KUZO_HOME="$WORK/kuzo-home"
  # Plus the existing KUZO_PLUGINS_DIR + isolated GITHUB_TOKEN etc.
  ```
  `$WORK/kuzo-home/credentials.enc` is created fresh per run with the test passphrase. Each plugin's required credentials get satisfied via env overrides (test sets `GITHUB_TOKEN` etc. directly), so the store remains empty — but the passphrase mode is configured in case any plugin's optional credential test path needs it. Documented in §E.5 + §F.1 acceptance + the parity-test script's preamble comment.
- **`KUZO_PLUGINS_DIR` precedence is preserved** — if a user sets BOTH `KUZO_HOME=/x` and `KUZO_PLUGINS_DIR=/y`, plugins live at `/y` and the rest of state at `/x`. Verified by the precedence test in F.1.

---

## Part F — Acceptance, open questions, cutover

### F.1 Acceptance criteria

**Part A — Storage**

- [ ] `packages/core/src/credentials/{store,key-provider,cipher,source,env-overrides}.ts` exist with documented interfaces.
- [ ] `@napi-rs/keyring` pinned exactly to `1.3.0` in `packages/core/package.json`.
- [ ] Unit tests cover: encrypt round-trip with keychain provider (using `InMemoryKeyProvider` test double); encrypt round-trip with passphrase provider; tamper detection (flip 1 byte in header → decrypt fails closed); KDF downgrade attempt (swap `kdfId` from 0x01 to 0x00 → decrypt fails closed); empty store handling (file does not exist → `get` returns undefined).
- [ ] Concurrent `store.set` from two processes is **prevented** by the shared `~/.kuzo/.lock` (Part B §B.6); without the lock, document the last-writer-wins race in cleanly-tested isolation.
- [ ] File permissions verified: `~/.kuzo/credentials.enc` is mode 0600 after every write on POSIX.

**Part B — Provisioning UX**

- [ ] `kuzo credentials {set,list,delete,rotate,migrate,status}` subcommands exist under `packages/cli/src/commands/credentials/`.
- [ ] `set` and `rotate` accept secret only via interactive TTY prompt or explicit `--stdin`.
- [ ] `--stdin` reads exactly one line (trim trailing `\r?\n`), rejects empty/internal-newline/NUL values.
- [ ] Non-TTY without `--stdin` exits 65 with `E_NO_INPUT_MODE`.
- [ ] `migrate` performs read-back-verify before redacting source; on failure does not touch source files.
- [ ] `migrate` never writes a `.bak` file.
- [ ] `migrate --dry-run` shows the plan without mutating anything.
- [ ] **`.env` redaction uses dotenv parse → drop → re-serialize, NOT line-strip (round-1 advisory).** Fixture test: a `.env` containing a multi-line quoted credential value (e.g. `GITHUB_TOKEN="ghp_xxx\ntrailing-line"`), an `export`-prefixed entry, leading/trailing comments, and a blank line round-trips through migrate. After redaction: comments + blank lines + non-credential entries preserved verbatim; no fragment of the multi-line value's continuation line remains anywhere in the rewritten file; `dotenv.parse(rewritten)` succeeds with no orphan quote state.
- [ ] `kuzo plugins install` runs the inline-credential prompt for missing required credentials when interactive; respects `-y`.
- [ ] Audit log shows `credential.set` / `.deleted` / `.rotated` / `.migrated` / `.store_unlocked` / `.store_locked` events; no event includes the credential value.
- [ ] Shared lock at `~/.kuzo/.lock` prevents concurrent `kuzo plugins install` + `kuzo credentials set`.

**Part C — Broker**

- [ ] `runServer()` exported from `@kuzo-mcp/core/server`. Self-invocation guard at the bottom of `server.ts` still fires when invoked as `node packages/core/dist/server.js` (parity test continues to work).
- [ ] Boot sequence smoke test (R32 rewrite): after `runServer()` completes startup, the parent process satisfies (a) `process.env.GITHUB_TOKEN === undefined` (or never-defined), (b) `process.env.KUZO_PASSPHRASE === undefined` (or never-defined), (c) `freezePrototypes()` ran after `loadAll`, (d) `credentialStore.close()` runs after `loader.shutdownAll()` on SIGTERM. When the first MCP tool call spawns a plugin child via `PluginProcess`, the child's `process.env.GITHUB_TOKEN` is ALSO `undefined` — credentials reach the child only via the IPC `env` payload from `extractForPlugin`.
- [ ] ESLint synthetic-test acceptance (§C.9): planting `import { fork } from "node:child_process";` at the top of `packages/core/src/server.ts` fires the lint rule red; `pnpm run lint` exits non-zero.
- [ ] `extractCredentialCapabilities()` retained at `loader.ts:199-203` AND `loader.ts:332` (R29); deleted only `extractV2Config()`.
- [ ] Manifest-drift smoke (§C.1 invariant 6): a plugin whose `package.json#kuzoPlugin.capabilities` lists fewer `CredentialCapability` entries than its runtime manifest is skipped on load with `plugin.failed: manifest_drift`.
- [ ] `CredentialSource.get()` enforces env-override > store > undefined precedence.
- [ ] `KUZO_PASSPHRASE=...` set at boot: `KeyProvider` is `passphrase`; encrypted file decrypts; `credential.passphrase_consumed` audit event fires once.
- [ ] After `PassphraseKeyProvider.acquireKey()`, the provider's `passphrase` field is `undefined` (verified by reflection in the test).
- [ ] `KUZO_PASSPHRASE` is scrubbed from `process.env` regardless of the `--no-scrub` flag and regardless of `KUZO_NO_ENV_SCRUB=1`.
- [ ] `KUZO_PASSPHRASE` unset, keychain populated: `KeyProvider` is `keychain`; one prompt on first decrypt during `loader.loadAll()` (not on first tool call — parent-eager).
- [ ] `KUZO_DISABLE_KEYCHAIN=1` without `KUZO_PASSPHRASE`: `KeyProvider` is `NullKeyProvider`; the server boots; `store.get()` returns `undefined` for every key without ever calling `acquireKey()`; plugins that need stored credentials are skipped, plugins that read env overrides work.
- [ ] `KeyProvider` constructors are inert: instantiating `new KeychainKeyProvider()` performs no dbus / Keychain Services I/O; `new PassphraseKeyProvider(p)` performs no scrypt derivation.
- [ ] `KUZO_NO_ENV_SCRUB=1` emits stderr warning + skips declared-name scrub; `KUZO_PASSPHRASE` still scrubbed; audit `credential.scrub_disabled` event fires.
- [ ] `KEY_LOST` state (keychain entry deleted, `credentials.enc` present): `kuzo credentials set <name>` exits 72 with `E_KEY_LOST` and the wipe instructions message.
- [ ] `CORRUPTED` state (GCM verification fails): exits 73 with `E_FILE_CORRUPTED` and wipe instructions.
- [ ] `kuzo credentials wipe --confirm` succeeds in `KEY_LOST` and `CORRUPTED` states (does not call `acquireKey()` before deletion).
- [ ] Generation counter (R12): after `kuzo credentials set` succeeds, a `credentials.enc` from before the set fails decryption with `E_FILE_CORRUPTED` when copied back over the live file. Live keychain generation > restored file generation.
- [ ] `registerClientFactory("foo", fn)` works from a third-party plugin (via `PluginContext.credentials.registerClientFactory`, NOT a `@kuzo-mcp/core/credentials` subpath import) and integrates with the broker's `getClient`. Cross-plugin overrides ("plugin foo registers for service github") throw.
- [ ] All existing 2.5b/c audit events (`credential.client_created`, `.raw_access`, `.raw_denied`, `.fetch_created`) continue to fire AND route through IPC from plugin children to the parent (R16).
- [ ] Audit-forgery smoke (§C.10): a malicious plugin emitting an audit event with `plugin: "kuzo"` is logged as `audit.forged_plugin_field` with the real child PID + the impersonated plugin name; the impersonated entry is NOT written.
- [ ] Cross-version lock-path smoke (R27): a process holding `~/.kuzo/plugins/.lock` makes a new `kuzo credentials set` exit 30 with `E_LOCK_CROSS_VERSION`.
- [ ] `homedir() + ".kuzo"` grep returns zero matches outside `packages/core/src/paths.ts` (R26).
- [ ] `@kuzo-mcp/core` is pinned exact in `packages/cli/package.json` at publish time; `kuzo serve --version` prints matching cli + core versions (R30).
- [ ] `.env`-loaded credential triggers the migrate-nudge stderr warning once per boot (R31). `KUZO_NO_MIGRATE_NUDGE=1` suppresses.

**Part D — Server entry**

- [ ] `kuzo serve` subcommand exists in `@kuzo-mcp/cli` and starts the MCP server.
- [ ] `~/.claude/settings.json` block with `{"command": "kuzo", "args": ["serve"], "env": {}}` loads all configured plugins after `kuzo credentials migrate` from the prior settings.json env block.
- [ ] First-run message ("no credentials configured") prints on stderr only.
- [ ] Skipped-plugins summary fires once per boot, listing missing credentials per plugin.
- [ ] `kuzo serve --no-scrub` runs but emits the loud warning + audit event.

**Part E — Directory contract**

- [ ] `KUZO_HOME` env override works for all six paths in §E.1.
- [ ] `KUZO_PLUGINS_DIR` precedence over `KUZO_HOME/plugins` confirmed (parity test still green with `KUZO_PLUGINS_DIR` set + `KUZO_HOME` unset).
- [ ] `packages/core/src/paths.ts` is the single source of truth — no more `join(homedir(), ".kuzo", ...)` inline anywhere in the codebase.
- [ ] Keychain entry inspectable on macOS via `security find-generic-password -s kuzo-mcp -a master-key -w` and round-trips.

**Phase close**

- [ ] `docs/SECURITY.md` §6 updated — "Credential Storage (Phased)" table marks 2.5d+ as **shipped in 2.6** with the encrypted-blob design. Threat model gains vector 1/3/4/7 explicit mitigations + vector 2 (signed-but-evil plugin) called out as newly defended.
- [ ] `docs/PLANNING.md` — Phase 2.6 added between 2.5 and 3, summary paragraph + decision pointers.
- [ ] `docs/STATE.md` — Phase 2.6 entry with PR refs; "Fresh-session handoff" plan advances past implementation to the next phase (real-life QA via Claude Code per the broader roadmap).
- [ ] `README.md` — install instructions show the new `command: "kuzo", args: ["serve"]` block + a "Set credentials with `kuzo credentials migrate`" call-out.
- [ ] Live e2e smoke: fresh `npm install -g @kuzo-mcp/cli@<new-release>` on a clean macOS user account → `kuzo plugins install github` → inline credential prompt → set GITHUB_TOKEN → `kuzo serve` → Claude Code calls a github tool successfully. **No env vars or .env file involved.**

### F.2 Open questions for phase

| # | Question | Default if undecided | Decide by |
|---|---|---|---|
| F.1 | Should `kuzo credentials migrate` also scan Claude Desktop / VSCode MCP configs (not just Claude Code's `~/.claude/settings.json`)? | Defer — focus on Claude Code, document the manual-import path for others | Part B implementation |
| F.2 | Should the store support multiple master keys (rotation)? | Defer — single key in v1; rotation via "decrypt-and-re-encrypt-with-fresh-key" is a one-line CLI later | Part A implementation |
| F.3 | Should `kuzo credentials status` warn when env-override mode "shadows" a stored value, in case the user forgot the env var is set? | Yes — single-line "shadowed by env override" hint | Part B implementation |
| F.4 | Should we support a `--keychain-service` flag for parallel installs sharing a machine (e.g., two `kuzo` setups for different work accounts)? | Defer — single user, single keychain entry in v1; document workaround (`KUZO_HOME=~/work-kuzo` with `KUZO_PASSPHRASE` mode for the secondary) | Part E implementation |
| F.5 | Should the migration command auto-detect and warn on `*.env.bak` files (created by prior migration attempts under other tools)? | No — we don't create them; not our problem | Part B implementation |
| F.6 | Encrypt the audit log? | Defer — entries already redact values; encryption is post-2.6 if a specific threat surfaces | Phase close |
| F.7 | Lint rule banning `child_process.fork/spawn/exec` outside `packages/core/src/plugin-process.ts` to enforce Q5 invariant 5? | **Resolved in round 3 — must-land per §C.9.** ESLint rule scoped to `packages/core/src/server.ts` + `packages/core/src/loader.ts`. | Implemented in Part C §C.9; verified by §F.1 synthetic-test acceptance |
| F.8 | Should `kuzo credentials migrate` also remove the `kuzo` entry's `command: "node"` path-hardcoded args (replacing with `command: "kuzo", args: ["serve"]`)? | Yes — same atomic rewrite pass; mirrors the canonical block | Part B implementation |

### F.3 Cutover plan (from current state to phase complete)

1. **Branch created:** `phase-2.6/credentials`. Branch off `main` at the `0.0.2` published baseline.
2. **Spec commit:** this document → `docs/credentials-spec.md`.
3. **Brief reference:** `docs/credentials-spec-brief.md` stays (it's the input — annotated with "superseded by docs/credentials-spec.md" but not deleted; useful for the history of why decisions landed where they did).
4. **Part E commits (the cheap refactor):** new `paths.ts` + `consent.ts/audit.ts` refactor + tests. 1–2 commits. Parity test stays green.
5. **Part A commits:** storage primitives + tests. 3–5 commits split by file (cipher, key-provider, store, source, env-overrides).
6. **Part C commits:** `server.ts` refactor → `runServer()`, boot-sequence rewiring, loader.ts swap, write-side audit. 2–4 commits.
7. **Part B commits:** `kuzo credentials` command tree, command-by-command. 3–5 commits (set/list/delete/rotate one PR-equivalent; rotate one; status one; migrate alone — biggest risk).
8. **Part D commits:** `kuzo serve` bin, runServer export wiring. 1–2 commits.
9. **Phase-close commit:** doc updates (`SECURITY.md` §6, `PLANNING.md`, `STATE.md`, `README.md`). One commit.

   **README outline (R41) — target ~120 lines added under existing structure:**

   - **"Getting started"** — replace the existing single-command quickstart with the full sequence:
     1. `npm install -g @kuzo-mcp/cli`
     2. `kuzo plugins install github`
     3. inline credential prompt → paste token → "Stored."
     4. `~/.claude/settings.json` mcpServers wiring (the `{"command": "kuzo", "args": ["serve"], "env": {}}` block — copy-paste ready)
     5. Restart Claude Code.
     Mockup each step's expected output. The mockups are stable contract — flag drift in code review.

   - **"Credentials"** section:
     - **macOS user (default keychain mode)** — expected modal prompt on first `kuzo credentials set` (or first `kuzo serve` if a plugin pulls a stored credential), "Always Allow" tip + caveat that nvm/Volta/asdf binary swap = fresh prompt.
     - **Linux desktop user (Secret Service)** — same flow; note GNOME Keyring / KWallet must be running.
     - **Linux headless / CI** — `KUZO_PASSPHRASE` env pattern (link to §F.5 Pattern 2).
     - **`op run` / 1Password** — link to §F.5 Pattern 3.
     - **Volta / nvm / asdf users** — expect a fresh prompt per Node upgrade. "Always Allow" sticks per Node binary path + content hash, so upgrading rebuilds the prompt history.

   - **"Upgrading from 0.0.2"** section — explicit instructions:
     1. `npm install -g @kuzo-mcp/cli@latest` (or `pnpm add -g`).
     2. `kuzo credentials migrate` — interactive; reads `~/.claude/settings.json` + `.env`, imports + redacts.
     3. Restart Claude Code.
     Document the "your old env block keeps working until you migrate" backwards-compat guarantee.

   - **"Backups"** section — `credentials.enc` is encrypted at rest with the keychain master key. Time Machine + iCloud backup it (safely — ciphertext). Restore safety:
     - Full-system restore (Migration Assistant or Time Machine restore): keychain restores in lockstep; works.
     - File-only restore (`credentials.enc` copied without the keychain): file is uselessly opaque without the master key. Use `kuzo credentials wipe + migrate` on the new machine, re-provision from source.
     - **Rollback-resistance caveat:** the generation counter (R12) means restoring a stale `credentials.enc` while keeping the live keychain entry fails decrypt. By design — prevents in-place backup-rollback attacks. Documented affordance: keep `kuzo credentials list --json > ~/.kuzo-creds-backup.json` periodically so you know what to re-provision.

   - **"Recovery"** section — what to do if the keychain entry is lost (the `KEY_LOST` state from §A.11):
     1. Run `kuzo credentials wipe --confirm` (deletes both the keychain entry and the file).
     2. Re-provision via `kuzo credentials set <NAME>` for each credential OR `kuzo credentials migrate` if the source files (`~/.claude/settings.json`, `.env`) still have them.

   - **"CI / headless deployment"** subsection — link to §F.5 patterns.
10. **PR strategy:** single PR against `main` OR five smaller per-part PRs. **Recommend** per-part PRs (mirrors 2.5e Parts A/B/C/D split — easier review). Part B (`migrate`) is the highest-risk PR; ship it alone with extra reviewer focus.
11. **Release strategy:** changesets bump all 6 packages. `@kuzo-mcp/types` may stay at 0.0.1 if no type changes (note: `CredentialAccessMode` etc. are unchanged). `@kuzo-mcp/core` bumps minor (0.0.2 → 0.1.0 — new exports, new boot sequence). `@kuzo-mcp/cli` bumps minor (new subcommand tree). Three plugins bump patch (0.0.2 → 0.0.3 — no functional changes; bump only because consumer of core's minor bump). **Use a single coordinated release**, not per-package canaries, since the changes are interdependent.
12. **Live e2e validation post-release:**
    a. Fresh user account on a Mac, `npm install -g @kuzo-mcp/cli@<new>`.
    b. Existing user, `npm update -g @kuzo-mcp/cli` → `kuzo credentials migrate` → settings.json now empty `env: {}` → kuzo serve works.
    c. Linux-headless: `KUZO_PASSPHRASE=test kuzo credentials set GITHUB_TOKEN` → `kuzo serve` → reads from passphrase-encrypted store.

### F.4 Known phase-level risks

- **macOS keychain prompts on Apple Silicon vs. Intel.** Apple Silicon ad-hoc-signs binaries at link time differently than Intel — minor risk that an unsigned Node binary's ACL identity differs across architectures. Mitigation: smoke-test on both before release.
- **Volta/nvm/asdf user impact.** Every Node binary upgrade triggers a fresh keychain prompt. Document loudly in the README. Mitigation considered but rejected: shipping a signed helper binary. Out of scope (Apple Developer ID is $99/yr; we'd need to factor that into release infrastructure decisions).
- **`KUZO_PASSPHRASE` in shell history.** If a user does `KUZO_PASSPHRASE=secret kuzo serve` interactively, the passphrase appears in zsh/bash history. Mitigation: document the recommended pattern (`echo $KUZO_PASSPHRASE` from a credential manager) and the alternative (`launchctl setenv KUZO_PASSPHRASE` on macOS, systemd `Environment=` directive on Linux). The user is responsible for not pasting secrets into bare shells.
- **`@napi-rs/keyring` supply chain risk.** Per §A.9 Tier 1, the binding loads into every process. A compromised release reveals every stored credential. Mitigation: exact-version pin + manual bump review + prebuilt-binary checksum verification. Sigstore provenance of `@kuzo-mcp/*` doesn't extend to deps; we can't lock down the binding's release pipeline. **Why we still ship with a keychain dependency**: the alternative is "silently accept plain-env fallback when the keychain is unavailable" — `cli/cli#10108` documented this as a UX trap (users believe they're protected, in fact they're not). We fail loud instead — `KUZO_DISABLE_KEYCHAIN=1` is the explicit opt-out, with `NullKeyProvider` returning `undefined` for every store lookup so plugins that need stored credentials fail fast.
- **Settings.json rewrite breaking Claude Code.** Atomic rewrite + read-back-verify, but Claude Code parses settings.json on its own schedule. A migration that succeeds atomically but leaves Claude Code with a stale in-memory copy could lead to confusion. Mitigation: migration command's final line is "Restart Claude Code to pick up the new MCP server entry." Document.
- **Race between in-progress plugin install and credential write.** Shared lock at `~/.kuzo/.lock` prevents this. Verified by smoke (open two terminals, attempt concurrent `kuzo plugins install foo` and `kuzo credentials set X`; one waits or fails with exit 30).
- **Encrypted file format v1 lock-in.** Adding fields to the JSON payload is forward-compatible (decryption just sees extra fields). Changing the header layout requires a new magic and a migration path. Keep v1 simple; bump magic to "KCR2" only if forced.
- **Loss of master key.** If the user wipes their keychain (`security delete-generic-password -s kuzo-mcp`), `credentials.enc` becomes undecryptable. There is no recovery — the file is encrypted with that one key. Surfaced as `E_KEY_LOST` (exit 72) per §A.11. Recovery affordance: recommend periodic `kuzo credentials list --json > ~/.kuzo-creds-backup.json` so the user has a name-only manifest of what to re-provision after a `wipe`. The backup file contains only env-var names, never values.
- **Generation-persists-first ordering trades crash-recovery cheapness for rollback-attack resistance — deliberate.** §A.3 write-path step 10 (commit new generation) precedes step 11 (rename `credentials.enc.tmp`). A process crash, OOM kill, or power-loss between those two steps leaves the on-disk file at `G_old` while the live counter is `G_new`. Next boot fails GCM verification → `E_FILE_CORRUPTED` → user must `kuzo credentials wipe --confirm` and re-provision **every** credential. The window is small (a few syscalls, sub-millisecond on local FS) but non-zero, especially on memory-constrained boxes doing the 256 MiB scrypt allocation right before. **Why we chose this anyway:** reversing the order (file-first, generation-second) makes the rollback attack trivial — any FS-write malware just doesn't bump the generation file after restoring an old encrypted blob, and AAD verification still succeeds. A ±1 tolerance window (accepting `G_file ∈ [G_live - 1, G_live]`) was considered and rejected: it halves the rollback-resistance bar (attacker needs to roll back ≥2 generations instead of any number), but the actual rollback attack is "restore the file from a backup taken N rotations ago," and N is almost always >1. The tolerance trades real security for an unlikely-on-modern-FS crash recovery. Documented as a known UX cost; `kuzo credentials wipe + migrate` is the documented recovery path; mitigation lives in the `credentials list --json` backup affordance above.
- **Backup-rollback resistance breaks legitimate Time Machine restore.** Per R12, restoring `credentials.enc` from a Time Machine snapshot whose generation predates the live keychain entry's counter fails decrypt. Legitimate recovery path for users rebuilding a Mac:
  1. Restore the keychain via Migration Assistant / Time Machine keychain restore (one of the post-restore options).
  2. If only the file was restored (file-level backup, no keychain restore): run `kuzo credentials wipe --confirm`, then re-provision from source (`kuzo credentials migrate` or `kuzo credentials set ...`).
  Documented in the README "Backups" section per §F.3 step 9.
- **Rotation propagation is best-effort, not guaranteed.** Per §C.11, `kuzo credentials rotate` triggers a file-watch + IPC refresh to running plugin children. The parent-side store cache and the child-side broker scoped Map both update. BUT: plugins that constructed a long-lived API client at `initialize()` and stashed it outside `broker.getClient` (e.g., a custom Octokit wrapper held in plugin module state) keep using the old token until reconstructed. The first-party github/jira plugins go through `broker.getClient` every time and DO get the new token transparently; third-party plugins are documented to follow the same pattern. Fully reliable rotation requires a Claude Code restart.

### F.5 CI / headless deployment patterns (R39)

Implementers and users need documented patterns for running kuzo without a keychain.

**Pattern 1 — Pure env-override (recommended for ephemeral CI):**

```yaml
# .github/workflows/some-job.yml
env:
  KUZO_DISABLE_KEYCHAIN: "1"
  # No KUZO_PASSPHRASE — selects NullKeyProvider; the encrypted store is never touched.
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}
  JIRA_HOST: ${{ secrets.JIRA_HOST }}
  JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}
  KUZO_NO_MIGRATE_NUDGE: "1"  # suppress the "detected env credentials" banner (deliberate use)
```

Plugins never touch `credentials.enc`. Zero keychain interaction. Per-credential injection by the CI secrets manager. Each tool call resolves credentials directly from `process.env` via the `CredentialSource` env-override path. **This is the recommended default for CI.**

**Pattern 2 — Passphrase + stored credentials (for long-lived headless boxes):**

```yaml
env:
  KUZO_PASSPHRASE: ${{ secrets.KUZO_PASSPHRASE }}
  KUZO_HOME: /var/lib/kuzo
```

`credentials.enc` lives at `/var/lib/kuzo/credentials.enc`; passphrase derives the AES key per §A.2. Initial provisioning is a one-time operation on the box:

```bash
KUZO_PASSPHRASE="$(cat /run/secrets/kuzo-passphrase)" \
  kuzo credentials set GITHUB_TOKEN --stdin < /run/secrets/github-token
```

The `.generation` file lives next to `credentials.enc` at `/var/lib/kuzo/credentials.generation`. Both are read at every boot to assemble AAD per §A.3.

**Pattern 3 — `op run` injection (1Password):**

```bash
op run --env-file=./op.env -- kuzo serve
```

`op` injects credentials via env vars at process spawn. They flow through `collectEnvOverrides` → scrub → `CredentialSource` automatically. The `op.env` template:

```
GITHUB_TOKEN=op://Personal/GitHub/token
JIRA_API_TOKEN=op://Work/Jira/api-token
JIRA_HOST=op://Work/Jira/host
JIRA_EMAIL=op://Work/Jira/email
```

Same precedence as Pattern 1 — store is untouched (assuming `KUZO_DISABLE_KEYCHAIN=1` is set OR the user's keychain is unlocked).

**Pattern 4 — systemd Environment= or launchctl setenv (long-lived workstation daemon):**

Not common for kuzo today (we're stdio-only), but documented for completeness. Same env-injection mechanics as Pattern 1; the secrets are stashed in the systemd `Environment=` directive or launchd's user-domain env vars.

**Acceptance (§F.1):** New CI smoke job runs Pattern 1 end-to-end via the parity-test fixture, asserting `get_repo_info` succeeds without any keychain interaction. Uses `KUZO_DISABLE_KEYCHAIN=1` + env-injected `GITHUB_TOKEN` + isolated `HOME`.

---

## Appendix — reference implementations cited

- [`microsoft/vscode`](https://github.com/microsoft/vscode) / [`Electron safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) — the "one keychain entry, encrypted blob on disk" pattern that this spec adopts as primary. VSCode's `SecretStorage` API is the closest analog to our broker → plugins surface.
- [`cli/cli`](https://github.com/cli/cli) — gh CLI. `internal/keyring/keyring.go` shows the thin-wrapper-around-zalando-go-keyring pattern. The open issue `cli/cli#10108` ("error rather than silent plaintext fallback") is the explicit guidance for our `KUZO_DISABLE_KEYCHAIN` semantics.
- [`Brooooooklyn/keyring-node`](https://github.com/Brooooooklyn/keyring-node) — `@napi-rs/keyring`. Active, NAPI-RS wrapper over Rust `keyring-rs`. v1.3.0 (Apr 2026), 2 open issues at this writing.
- [`1Password/op` CLI](https://developer.1password.com/docs/cli/app-integration-security/) — daemon-backed credential delivery via NSXPCConnection. Out of scope to replicate; cited because `op run -- kuzo serve` is the documented Tier 4 path that flows through our env-override entry point with zero kuzo-side configuration.
- [`jaraco/keyring`](https://github.com/jaraco/keyring) — Python equivalent, used by 1Password Connect, Zowe, and others. Their issue tracker (especially `#477` on headless Linux) documents the Secret Service daemon dependency that our Linux fallback strategy addresses with `KUZO_PASSPHRASE`.
- [Apple Technical Note TN2206](https://developer.apple.com/library/archive/technotes/tn2206/_index.html) — macOS code signing and Keychain ACL identity. Source for the unsigned-binary path+hash ACL claim.

## Sources

- VSCode SecretStorage API: <https://code.visualstudio.com/api/references/vscode-api#SecretStorage>
- Electron `safeStorage`: <https://www.electronjs.org/docs/latest/api/safe-storage>
- gh `auth login` manual: <https://cli.github.com/manual/gh_auth_login>
- gh CLI source — `internal/keyring/keyring.go`: <https://github.com/cli/cli/blob/trunk/internal/keyring/keyring.go>
- gh CLI issue `#10108` (no silent plaintext fallback): <https://github.com/cli/cli/issues/10108>
- `@napi-rs/keyring` npm: <https://www.npmjs.com/package/@napi-rs/keyring>
- `@napi-rs/keyring` source: <https://github.com/Brooooooklyn/keyring-node>
- Rust `keyring-rs` crate (Linux dbus-direct, no libsecret runtime dep): <https://docs.rs/keyring/latest/keyring/>
- OWASP password storage cheatsheet (scrypt params): <https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html>
- Node `crypto.scryptSync` docs: <https://nodejs.org/api/crypto.html#cryptoscryptsyncpassword-salt-keylen-options>
- 1Password CLI app integration security: <https://developer.1password.com/docs/cli/app-integration-security/>
- Apple TN2206 (Code Signing in Depth): <https://developer.apple.com/library/archive/technotes/tn2206/_index.html>
- MCP stdio transport — config conventions: <https://modelcontextprotocol.io/docs/concepts/transports>

---

**Spec locked 2026-05-10; round-3 + round-1/round-2 auto-review advisories absorbed 2026-05-12.** Implementation per the cutover plan in §F.3. Edits to the design land in PR diffs to this file, not in `docs/credentials-spec-brief.md` (which is the historical input). The round-3 remediation notes (`docs/credentials-spec-round3-notes.md`) are kept in-tree for implementation cross-reference; tracked for removal during the phase-close commit per issue #39.
