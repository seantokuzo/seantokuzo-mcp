# Phase 2.6 — Credential Storage & Provisioning Spec

> Implementation north star for Kuzo MCP's credential lifecycle phase: encrypted-on-disk storage with OS-keychain key wrap, `kuzo credentials` CLI surface, `process.env` scrub, and a friendly `kuzo serve` entry point that decouples the MCP server from plaintext-on-disk secret blocks.

**Status:** Spec — not yet implemented. Every section below is binding unless marked `[uncertain]`.
**Source brief:** `docs/credentials-spec-brief.md` (locked 2026-05-04 after two rounds of review advisories).
**Predecessor research:** `docs/SECURITY.md` §6 (broker design — shipped in 2.5b/2.5c).
**Source research:** completed 2026-05-10 against current tool versions (`@napi-rs/keyring@^1.3.0`, Node 20+, Inquirer 9.x, Commander 12.x).
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
3. **Part C (broker):** boot-time `process.env` scrub with pinned ordering (broker populated → env scrubbed → plugins loaded → freeze prototypes); lazy-decrypt store; third-party `getClient` factory registration; write-side audit events.
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
| 5 | `process.env` scrub | Yes. Boot-ordering invariants pinned in `server.ts` code order. Kill-switch via `KUZO_NO_ENV_SCRUB=1` for dotenv-library-collision case. Strictly: no `child_process.spawn/fork/exec` may be invoked between `ConfigManager` construction and the scrub. | No |
| 6 | Provisioning UX shape | Inline-after-`plugins install` prompt **plus** standalone `kuzo credentials set/list/delete/rotate/migrate/status`. **No `get`** (footgun-shaped — `list` shows what's set; `audit` shows what was read). Secret input: interactive echo-off prompt **or** explicit `--stdin` flag. No positional/flag value for the secret, ever. | Brief default + drop `get` |
| 7 | `~/.claude/settings.json` migration | `kuzo credentials migrate` — warns first, requires explicit confirm (or `--yes`). Atomic rewrite with the value redacted; **no `.bak` file**. Read-back-verify by byte-compare before rewriting the source. In-memory cleartext zeroed only after read-back passes (success) or after the failure-path audit-emit completes. | No |
| 8 | Friendly MCP server entry | `kuzo serve` bin in `@kuzo-mcp/cli`. Refactor existing `packages/core/src/server.ts` main into an exported `runServer({ scrub })` function. New canonical settings.json block has empty `env: {}`. | No |
| 9 | GitHub App tokens in v1 | Deferred. PAT-only. `set` accepts `--type pat` (default) and reserves `--type app`. | No |
| 10 | Plugin manifest schema changes | None. `CredentialCapability` is already the surface; provisioning reads it. | No |
| 11 | Multi-account support | Deferred. Single value per credential name. `account: string` discriminant deferred to a future phase. | No |
| 12 | Rotation flow | `kuzo credentials rotate <name>` — audit-distinct alias for `set`; emits `credential.rotated` instead of `credential.set`. | No |
| 13 | `KUZO_HOME` env override | Yes. Default `~/.kuzo/`. Precedence for plugins root: `KUZO_PLUGINS_DIR > KUZO_HOME/plugins > ~/.kuzo/plugins` (preserves 2.5e parity test). | No |
| 14 | Audit on credential writes | Yes. New `AuditAction` variants: `credential.set`, `credential.deleted`, `credential.rotated`, `credential.migrated`, `credential.store_unlocked`, `credential.store_locked`. None record the value. | No |
| 15 | Shutdown scrub | Yes. `EncryptedCredentialStore.close()` zeroes the in-memory cleartext map. Each plugin's `DefaultCredentialBroker` shutdown call also zeroes its scoped Map. Wired in `server.ts` shutdown path before `registry.shutdownAll()`. | No |
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

### Cross-cutting build order

The six parts have dependencies. Recommended order — each numbered group is one or more atomic commits on `phase-2.6/credentials`:

1. **E.1–E.2: `KUZO_HOME` + shared `packages/core/src/paths.ts`** — refactor existing path helpers; consent.ts and audit.ts pick up new helpers. Zero behavior change.
2. **A.1–A.4: Storage primitives** — cipher, key providers (keychain + passphrase), `CredentialStore` interface, `EncryptedCredentialStore` impl. Unit tests against tmpdir + an `InMemoryKeyProvider` test double.
3. **A.5–A.6: CredentialSource + env-override collection** — bridges store + env. Pure logic, easy to test.
4. **C.1–C.3: Boot sequence rewrite** — refactor `server.ts` main → `runServer()`; insert credential-source build + scrub before `loader.loadAll()`; `loader.ts` swaps `configManager.extractPluginConfig` → `credentialSource.extractForPlugin`. Existing parity test must stay green; a new boot-sequence smoke proves scrub happens before any plugin init.
5. **C.4–C.6: Broker write-side audit events + shutdown hooks** — add `credential.set` etc. to `AuditAction` union; wire shutdown scrub.
6. **B.1–B.3: `kuzo credentials set/list/delete/rotate/status`** — new command tree under `packages/cli/src/commands/credentials/`. Inquirer prompts; no flag/arg value for secrets. Lock file shared with `kuzo plugins` (single `~/.kuzo/.lock` for any write to the kuzo home — see E.2).
7. **B.4: `kuzo credentials migrate`** — settings.json + .env import with atomic rewrite + read-back-verify. Most footgun-rich command; ship it last and gate behind explicit confirm.
8. **D.1–D.3: `kuzo serve` bin** — wraps `runServer()`. Update `packages/cli/package.json` bin entry. Verify via Claude Code's MCP settings.json after install of `@kuzo-mcp/cli@0.0.3`.
9. **F: Docs + canary** — update `SECURITY.md` §6, `PLANNING.md`, `STATE.md`. Cut a coordinated release for all 6 packages (`@kuzo-mcp/types` may stay at 0.0.1 if no contract changes; core + cli + plugins bump to 0.1.0 for first credentialed release).

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

**Cipher:** AES-256-GCM. Node built-in `crypto.createCipheriv("aes-256-gcm", key, nonce)` — zero new deps, well-audited path, ChaCha20-Poly1305 is fine but offers nothing AES-GCM doesn't on hardware-accelerated platforms (every macOS/Windows/x86-64 Linux desktop we care about).

**Nonce:** 96-bit random per encryption (`crypto.randomBytes(12)`). Stored in the file header.

**AEAD additional data (AAD):** the file header (magic + version + KDF id + KDF params block). Tampering with the header (e.g., flipping the KDF id from "keychain" to "passphrase" to attempt a downgrade attack) breaks decryption with a `BAD_DECRYPT` error.

**KDF (passphrase mode only):** `crypto.scryptSync(passphrase, salt, 32, { N: 2**17, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })`. `N=2^17` (~130k iterations) is the OWASP 2023 recommendation; ~100ms cost on a 2024 laptop. Salt is 16 bytes random, stored in the KDF params block of the file header.

**Master key:** 32 bytes (AES-256). Either:
- **Keychain mode**: base64-encoded random 32 bytes, stored at `service="kuzo-mcp" account="master-key"` via `@napi-rs/keyring`.
- **Passphrase mode**: derived from `process.env.KUZO_PASSPHRASE` via the scrypt KDF over the salt in the file header. Passphrase never touches disk; salt does.

### A.3 File format — `~/.kuzo/credentials.enc`

```
Offset   Size   Field
─────────────────────────────────────────────────────────────
0        4      Magic bytes:        "KCR1" (0x4B 0x43 0x52 0x31)
4        1      Format version:     0x01
5        1      KDF id:             0x00 = keychain (no KDF), 0x01 = scrypt
6        ?      KDF params block:   16-byte salt if scrypt; empty if keychain
─────────────────────────────────────────────────────────────  ← AAD ends here
6 + p    12     Nonce               (96-bit random per encryption)
6 + p+12 N      Ciphertext          (AES-256-GCM output)
end-16   16     Tag                 (GCM tag)
```

`p` is 0 for keychain mode, 16 for passphrase mode. The AAD covers bytes 0 through `5 + p`. Any header tamper (version flip, KDF downgrade, salt swap) fails decrypt.

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
2. Decrypt existing file into plaintext map (or start with `{}` if absent).
3. Apply mutation to the map.
4. Update `lastUpdated`.
5. Generate fresh 12-byte nonce.
6. Encrypt with the master key + nonce + new AAD.
7. Write to `~/.kuzo/credentials.enc.tmp`; `fsync`; `rename` to `~/.kuzo/credentials.enc`. Atomic on POSIX, atomic-ish on Windows (NTFS `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`).
8. Audit-emit `credential.set` / `.rotated` / `.deleted` / `.migrated` with key name only — never the value.

**Read path** (broker `get`):
1. Acquire master key (cached after first call within process lifetime).
2. Decrypt file once on first read; cache plaintext map in `EncryptedCredentialStore` instance.
3. Return value by key.

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

  /** Whether a key is present, without decrypting (uses cached plaintext map). */
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
export class PassphraseKeyProvider implements KeyProvider {
  readonly id = "passphrase";
  readonly kdfId = 0x01;
  private cached: Buffer | undefined;

  constructor(private readonly passphrase: string) {
    if (!passphrase) {
      throw new KeyProviderError(
        "KUZO_PASSPHRASE is empty — refusing to derive a key from empty string.",
      );
    }
  }

  acquireKey(headerKdfParams: Buffer): Buffer {
    if (this.cached) return this.cached;
    if (headerKdfParams.length !== 16) {
      throw new KeyProviderError(
        `Expected 16-byte salt in header; got ${headerKdfParams.length}`,
      );
    }
    this.cached = scryptSync(this.passphrase, headerKdfParams, 32, {
      N: 2 ** 17,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    return this.cached;
  }

  initializeKey(): { key: Buffer; kdfParams: Buffer } {
    const salt = randomBytes(16);
    const key = scryptSync(this.passphrase, salt, 32, {
      N: 2 ** 17, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
    });
    this.cached = key;
    return { key, kdfParams: salt };
  }
}
```

**`InMemoryKeyProvider`** — test double only. Throws if instantiated outside `NODE_ENV=test` / `KUZO_TEST=1`. Used by `EncryptedCredentialStore` unit tests so we don't need a real keychain in CI.

**Selection logic** (in `server.ts` boot):

```typescript
function chooseKeyProvider(): KeyProvider {
  if (process.env.KUZO_DISABLE_KEYCHAIN === "1") {
    if (!process.env.KUZO_PASSPHRASE) {
      throw new Error(
        "KUZO_DISABLE_KEYCHAIN=1 but KUZO_PASSPHRASE is unset. " +
        "Set KUZO_PASSPHRASE or remove KUZO_DISABLE_KEYCHAIN.",
      );
    }
    return new PassphraseKeyProvider(process.env.KUZO_PASSPHRASE);
  }
  if (process.env.KUZO_PASSPHRASE) {
    // Explicit passphrase opt-in even when keychain is available
    return new PassphraseKeyProvider(process.env.KUZO_PASSPHRASE);
  }
  return new KeychainKeyProvider();
}
```

Precedence: `KUZO_PASSPHRASE` set → use it. Otherwise → keychain.
`KUZO_DISABLE_KEYCHAIN=1` requires `KUZO_PASSPHRASE` and fails loud if absent — no silent plain-env fallback (`cli/cli#10108` lesson).

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

  /** Extract creds for a plugin from its declared CredentialCapability list. */
  extractForPlugin(
    caps: readonly CredentialCapability[],
  ): { config: Map<string, string>; missing: string[] } {
    const config = new Map<string, string>();
    const missing: string[] = [];
    for (const cap of caps) {
      const value = this.get(cap.env);
      if (value !== undefined) {
        config.set(cap.env, value);
      } else {
        missing.push(cap.env);
      }
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
 * No-ops when KUZO_NO_ENV_SCRUB=1 (kill-switch).
 */
export function scrubProcessEnv(scrubKeys: readonly string[]): void {
  if (process.env.KUZO_NO_ENV_SCRUB === "1") return;
  for (const key of scrubKeys) {
    delete process.env[key];
    delete process.env[`KUZO_TOKEN_${key}`];
  }
}
```

`declaredEnvNames` is built at boot from the union of all `CredentialCapability.env` values across all enabled plugin manifests. This is a small synchronous walk; the manifests are dynamic-imported by the loader at this point anyway.

### A.8 Migration from `.env` (one-time on `kuzo credentials migrate`)

`process.env` still gets populated from `.env` at boot by `ConfigManager.loadDotenv()` (existing). That stays — `.env` is also where users keep non-secret config like `LOG_LEVEL`. The migration command is what removes the **credential** entries from `.env` and the settings.json env block; the dotenv load itself doesn't change.

Migration flow detail is in Part B §B.4.

### A.9 Dependency policy for `@napi-rs/keyring`

Per the brief's §2 vector 7 (keychain-binding supply chain compromise), the binding loads into every kuzo-mcp process and mediates every credential read. Blast radius on compromise is total. Concrete policy:

1. **Pin minor.** `"@napi-rs/keyring": "1.3.0"` in `packages/core/package.json` (exact, no `^`). Same posture as `pacote` and `sigstore` in 2.5e (`^` allowed but minor bumps reviewed).
2. **Manual review on every bump.** `pnpm update @napi-rs/keyring` must be its own PR. Diff the package's CHANGELOG and the GitHub release notes; eyeball any new transitive deps.
3. **No transitive auto-bumps.** `pnpm-lock.yaml` is the source of truth. CI checks lockfile cleanliness.
4. **Dependabot alerts on the package.** Repo's Dependabot already runs; this is automatic.
5. **No alternative bindings shipped in parallel.** One binding, one Rust transitive surface. Adding `node-keytar` as a fallback would double the attack surface for no UX gain.
6. **Adapter wraps it.** `KeychainKeyProvider` is the only file that imports `@napi-rs/keyring`. The rest of the codebase imports `KeyProvider`. Swap-out cost is one file if a future advisory forces it.

Future hybrid options (if hybrid lands beyond v1: `age`, `sops`, custom shell-out to `security`/`secret-tool`) are gated by the same policy. They live behind `KeyProvider` and ship one-at-a-time, not in parallel.

### A.10 Known gotchas

- **`@napi-rs/keyring` is sync.** All methods are synchronous. Calling them from an event loop callback blocks. Acceptable for our use case (one call at boot, cached) but document so callers don't sprinkle calls in hot paths.
- **`@napi-rs/keyring` has no `findByPrefix`.** API surface is `Entry(service, account)` + `setPassword/getPassword/deletePassword`. We don't need enumeration — one entry, one account.
- **Linux without Secret Service daemon** (SSH session, CI, WSL2 without keyring): `Entry.getPassword()` throws. `KeychainKeyProvider` re-throws as `KeyProviderError` with a clear "Run with KUZO_PASSPHRASE set" message. `kuzo credentials status` must detect this state and explain.
- **macOS "Always Allow" sticks per binary path + content hash.** Volta/nvm/asdf swapping Node binaries triggers a fresh prompt. That's one prompt for the **master key** (unlocks the whole blob), not per credential — VSCode pattern wins here. Document that the prompt is expected after each Node upgrade.
- **`crypto.scryptSync` default `maxmem` is 32MiB**, which throws with `N=2^17 r=8 p=1` (requires ~128MiB). Always pass `maxmem: 64 * 1024 * 1024` (some slack). Verified locally.
- **Backup tools.** Time Machine and iCloud backup `~/.kuzo/credentials.enc` (good — ciphertext, safe in backups) **but** keychain entries are NOT in the home dir tree most backup tools index. A restored backup is decryptable only if the original keychain is also restored (Time Machine restores keychain too — full-system restore safe). Migrating Macs without a keychain restore = ciphertext file useless. Document in the migration runbook (F.3).
- **Windows ACL.** `fs.chmod(file, 0o600)` on Windows is a no-op for the underlying ACL. NTFS inherits from the user profile dir which is typically per-user-only. Acceptable for v1; hardening with explicit ACL is post-v1.
- **Header AAD covers KDF id.** A backup-restore that swaps the KDF id (e.g. takes a passphrase-encrypted file and tries to decrypt with keychain) fails at GCM verification — not just at "no key found." Defensive but cheap.

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
                                        --type pat        Credential type. Default 'pat'.
                                                          'app' reserved for future GitHub App support.
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
```

No `get` subcommand. Rationale: `get` is footgun-shaped — pipes the value into shell history if the user redirects, exposes it on `ps aux` if a wrapper script calls it inline, and there's no good use case in v1 (the broker reads values directly; users want `list`/`status` to confirm what's set, not the raw value). If a debugging session genuinely needs to inspect, `kuzo audit --action credential.fetch_created --plugin <name>` shows what was read; the user can rotate to verify it works.

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
  type: "pat";
  yes: boolean;
}
new Command("set")
  .argument("<name>", "Credential name (env-var-style, e.g. GITHUB_TOKEN)")
  .option("--stdin", "Read value from stdin", false)
  .option("--type <type>", "Credential type", "pat")
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
✔ Installed @kuzo-mcp/plugin-github@0.1.0
✔ Consent granted: 4 capabilities

This plugin needs 1 credential:
  GITHUB_TOKEN — Authenticates with the GitHub API for all operations

? Configure now? (Y/n)
  ✔ GITHUB_TOKEN
    [interactive prompt; echo-off]

Stored. To rotate: `kuzo credentials rotate GITHUB_TOKEN`.
```

With `-y`, the inline block is skipped — user gets the "configure later via `kuzo credentials set`" hint instead. Audit emits `credential.set` per credential just like the standalone `set` command.

If the credential is already set (env override OR stored value), the inline block skips that entry and shows `✔ GITHUB_TOKEN (already configured via env)` or `(via keychain)`. Re-running install doesn't re-prompt for existing creds.

Optional creds (`optionalCapabilities` with `kind: "credentials"`) are listed but not required — user can skip.

### B.4 `kuzo credentials migrate` — the footgun command

Reads:
- `~/.claude/settings.json` — finds MCP server entries whose `command` matches `kuzo`, `node` with `@kuzo-mcp/core`, or any prior canonical paths. Reads each entry's `env: { … }` block.
- `.env` files at: repo root (cwd ancestors with a `package.json` containing `@kuzo-mcp/cli`), `$HOME/.env`. Skips the system `.env` (not a thing on macOS/Linux).

For each candidate key:
1. Filter by **known credential env names** — the union of `CredentialCapability.env` values across installed plugins (via `index.json`) plus the legacy plain names (`GITHUB_TOKEN`, `JIRA_*`, etc.). Other env vars (`LOG_LEVEL`, etc.) are not touched.
2. Skip if the credential is already stored AND the existing stored value matches (no-op).
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

With `--dry-run`, exit here.

On confirm:
1. For each credential:
   a. `store.set(name, value)` — encrypts + writes.
   b. **Read-back-verify**: `store.get(name) === value`. Byte compare. If mismatch, abort the entire migration (rollback any earlier `store.set` calls for this run by restoring the original encrypted file from a memory copy taken at the start), surface `E_READBACK_FAIL`, exit 60.
   c. Audit `credential.migrated` with key name only and `source: "claude-settings" | "env-file"`.
2. After **all** read-backs pass, rewrite each source file:
   - `settings.json`: parse, delete each migrated key from the kuzo MCP entry's `env` block, write to `settings.json.tmp`, `fsync`, `rename` over `settings.json`. **No `.bak` file.**
   - `.env` files: same dance — strip matching lines (preserving comments / non-cred lines), write tmp, rename.
3. If any source rewrite fails:
   - The credential is already in the store (succeeded at step 1).
   - The source file still has the cleartext value (worse — duplicated).
   - Audit `credential.migration_partial` with the failed source path.
   - Surface: "Migration partially succeeded. The credential is stored, but I could not redact `<file>`. Manually remove the entry from that file and re-run `kuzo credentials status` to confirm."
   - **Do NOT roll back the store** — the user has the source as a fallback. Better duplicate than missing.
4. After source rewrites: zero all in-memory cleartext (overwrite buffers with `0x00` then `.fill(0)`, drop references).

**Failure-mode invariants**:
- **No `.bak` files anywhere.** Atomic tmp+rename only. Reason: `.bak` files are exactly the kind of forgotten plaintext leak that the brief's vector 3 (backups / dotfiles commits) talks about.
- **In-memory secret zeroing happens AFTER the success path completes, not earlier.** Read-back-verify must have something to compare against; clearing the buffer right after `store.set()` returns leaves nothing to verify with. The brief's Q7(d) calls this out explicitly.
- **Audit log redaction.** Audit entries name the credential KEY and the source, never the value. The audit helper `auditLogger.log({...})` is already shape-locked from 2.5c — `details: { credentialKey: name, source }` is fine.
- **No partial-success rollback for the store.** If we rolled back, the user might be left with a partially-redacted `settings.json` and no stored credentials — strictly worse than "stored + source has duplicate."
- **Confirm prompt cannot be `-y` by default for migrate.** `--yes` is opt-in for automation, but the prompt is the documented happy path. (We're rewriting a file owned by the user's editor; explicit consent matters.)

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

`status` is broader — surfaces:

```
Backend
  Key provider:   keychain (@napi-rs/keyring, service=kuzo-mcp account=master-key)
  Store file:     ~/.kuzo/credentials.enc  (mode 0600, size 412 B, modified 2026-05-15 10:32)

Credentials
  GITHUB_TOKEN     ✔ set (store)
  GITHUB_USERNAME  ✔ set (env override: KUZO_TOKEN_GITHUB_USERNAME)
  JIRA_HOST        ✔ set (store)
  JIRA_EMAIL       ✔ set (store)
  JIRA_API_TOKEN   ✔ set (store)

Plugins
  ✔ git-context        no credentials required
  ✔ github             all required credentials available
  ✔ jira               all required credentials available

Environment overrides active
  KUZO_TOKEN_GITHUB_USERNAME (value redacted)
```

`status` walks the installed-plugins `index.json` to know which capabilities to surface. For un-installed but enabled plugins (dev-mode), it falls back to scanning the workspace.

### B.6 Lock sharing with `kuzo plugins`

`kuzo plugins install/update/uninstall/rollback` already acquires `~/.kuzo/plugins/.lock` for write operations. `kuzo credentials set/delete/rotate/migrate` also writes to `~/.kuzo/credentials.enc`. Both touch the kuzo-home directory.

**Decision:** single shared lock at `~/.kuzo/.lock`. `kuzo plugins install` + `kuzo credentials set` cannot run concurrently. Acceptable for personal use — these are interactive commands. Move `lock.ts` from `packages/cli/src/commands/plugins/` to `packages/cli/src/lock.ts` (shared utility); `pluginsLockPath()` becomes `kuzoHomeLockPath()`. Existing `kuzo plugins` exit code 30 (`E_LOCK_CONTENTION`) stays.

`list` and `status` are read-only — no lock.

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
```

Event payloads (the `details` field) never include the value. They include:
- `credentialKey` — the env-var-style name.
- `source` — for `migrated` events: `"claude-settings" | "env-file"`. For `store_unlocked`: `"keychain" | "passphrase"`.
- `before` / `after` — for length comparisons (e.g. on rotate) without echoing values. Optional.

Existing `credential.client_created` / `.raw_access` / `.raw_denied` / `.fetch_created` stay. The new write-side events are emitted by the CLI handlers (not by the store directly — the store doesn't have audit context for who initiated the write). The CLI passes a request-scoped `AuditLogger` instance into store methods, or wraps the call site.

**Recommended split:** the store emits `store_unlocked` / `store_locked` (lifecycle it owns). The CLI emits the user-facing events (`set`, `deleted`, `rotated`, `migrated`).

### B.8 Known gotchas

- **Inquirer's `password`-type echo-off behavior is reliable on TTY, but **not** in some VSCode terminal integrations.** If `process.stdout.isTTY === true` but `process.stdin.isTTY === false`, refuse with a clear error rather than silently reading visible input.
- **Trim only trailing newlines.** `--stdin` users may paste tokens via `pbpaste \| kuzo credentials set ... --stdin` — leading whitespace is part of the secret on the very rare token type that has it; trailing newline is shell artifact. `value.replace(/\r?\n$/, "")` only.
- **Confirm-prompt-with-`-y`-allowed-but-not-default.** `migrate` skips the confirm with `--yes`. Without it, the prompt is required even in non-TTY (where it auto-fails on no-TTY input — that's intentional, forces explicit `--yes`).
- **`pbpaste` on macOS strips the trailing newline implicitly.** No additional handling needed beyond the trim.
- **Linux terminals that don't support echo-off** (rare but possible — some serial console setups). Inquirer falls back to plain echo. Refuse rather than echo: detect via `process.stdin.isRaw` after Inquirer's setup. Edge case; document in F.4 risks.
- **Migration of `~/.claude/settings.json` is tied to Claude Code's file format.** That file's schema isn't formally versioned. If the schema changes (new wrapper around `mcpServers`), the migration parser fails closed — surface "could not parse settings.json; manually remove the env block." Acceptable for v1.
- **Migrate from project-local `.env` may pick up unintended keys.** Filter strictly by the known-credential-names set; don't migrate anything not in the union of plugin `CredentialCapability.env` values.

---

## Part C — Broker upgrades

> Insert credential-store wiring + `process.env` scrub into the server boot sequence. Pin ordering invariants in code so they cannot regress silently. Add lazy fetch, third-party factory registration, and write-side audit. Wire shutdown scrub.

### C.0 Scope

**In:** `server.ts` boot refactor (extract `runServer()`); `loader.ts` source swap (CredentialSource for ConfigManager.extractPluginConfig); env-override collection + scrub at boot; lazy decrypt in the store; third-party `getClient` factory registration; shutdown hooks; new audit events plumbed.

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

  // 4. ★ NEW: credential store (lazy — does not decrypt until first .get())
  const keyProvider = chooseKeyProvider();
  const credentialStore = new EncryptedCredentialStore({
    filePath: credentialsFilePath(),
    keyProvider,
    auditLogger,
    logger,
  });

  // 5. ★ NEW: build the set of declared credential env names from enabled plugins
  //    (peeks at the kuzo.config.ts plugin list + their manifests, NO plugin init yet)
  const declaredEnvNames = await collectDeclaredCredentialEnvNames(
    configManager.getPluginConfig(),
  );

  // 6. ★ NEW: collect env overrides for declared names + KUZO_TOKEN_* pattern
  const envOverrides = collectEnvOverrides(declaredEnvNames);

  // 7. ★ NEW: scrub matched names from process.env BEFORE any child can inherit
  if (doScrub) {
    scrubProcessEnv([
      ...declaredEnvNames,
      ...Object.keys(envOverrides),
    ]);
  } else {
    logger.warn(
      "process.env scrubbing DISABLED (--no-scrub). Plugin children may inherit credential env vars.",
    );
  }

  // 8. credential source (env override > store)
  const credentialSource = new CredentialSource(credentialStore, envOverrides);

  // 9. plugin loader (existing — credentialSource replaces direct process.env reads)
  const loader = new PluginLoader(
    configManager,
    new PluginRegistry(),
    new KuzoLogger("loader"),
    consentStore,
    auditLogger,
    credentialSource,        // ← new constructor arg
  );

  // 10. load plugins (existing — no plugin init has run before this point)
  await loader.loadAll();

  // 11. freeze prototypes (existing — must run AFTER loadAll per 2.5a fix)
  freezePrototypes();

  // 12. start MCP transport (existing)
  const server = buildMcpServer(loader.registry);
  await server.connect(new StdioServerTransport());

  // 13. shutdown hooks (existing + extended)
  attachShutdownHandlers(async () => {
    await loader.shutdownAll();
    await registry.shutdownAll();
    credentialStore.close();                  // ★ NEW: zero in-memory cleartext
  });
}
```

**Pinned invariants** (enforced by code order, also asserted by a new boot-sequence smoke test in Part F):

1. `collectEnvOverrides()` must execute **before** `scrubProcessEnv()` (otherwise the values are gone before we capture them).
2. `scrubProcessEnv()` must execute **before** `loader.loadAll()` (otherwise plugins / their children see unfiltered `process.env`).
3. `loader.loadAll()` must execute **before** `freezePrototypes()` (preserved from 2.5e A.9 — protects plugin manifest imports from frozen-prototype issues).
4. `credentialStore.close()` must execute **after** `loader.shutdownAll()` (plugins may make final credential reads during shutdown).
5. **No `child_process.fork/spawn/exec`** between `ConfigManager` construction (step 2) and `scrubProcessEnv()` (step 7). The existing code base satisfies this — `PluginProcess` only forks on the first `callTool`, which can't fire before `loader.loadAll()` completes. Document the invariant; a lint rule for this is overkill.

### C.2 Env-var-first precedence (gh-style)

Within `CredentialSource.get()`: env override wins over store. This mirrors `gh`'s `GH_TOKEN > GITHUB_TOKEN > stored` precedence (research Task 2). The "always use the most-explicit source" rule:

- `op run -- kuzo serve` works out of the box — `op` injects `GITHUB_TOKEN=ghp_xxx` at spawn, `collectEnvOverrides()` picks it up, scrub clears it from `process.env`, the value flows through `CredentialSource` to the plugin's child.
- `KUZO_TOKEN_GITHUB_TOKEN=ghp_xxx kuzo serve` also works — same path.
- A pre-existing keychain entry remains the long-term store; env override is per-invocation.

**No `KUZO_CRED_BROKER=op` flag.** Not needed — env-override-first handles it. The brief's recommended `KUZO_CRED_BROKER` env var is dropped from the spec (acknowledged in the locked decisions). `op run` is the documented pattern; no extra flag.

### C.3 Lazy decrypt in the store

`EncryptedCredentialStore.get()` is lazy:

```typescript
class EncryptedCredentialStore implements CredentialStore {
  private cache: Map<string, string> | undefined;

  get(key: string): string | undefined {
    return this.loaded().get(key);
  }

  private loaded(): Map<string, string> {
    if (this.cache) return this.cache;
    const raw = readFileSync(this.filePath); // ENOENT → return empty Map
    const map = this.decrypt(raw);            // may prompt keychain on macOS
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

First plugin to call `getClient` triggers the keychain prompt (or scrypt KDF). Subsequent plugins / tools reuse the cache. **One unlock per server lifetime.**

If no plugin ever requests a stored credential (e.g., env-override-only setup), the store is never decrypted, the keychain is never touched. Zero-cost when not needed.

### C.4 Third-party `getClient` factory registration

Brief Tier 3 ask. Today the broker has a hardcoded `clientFactories` map in `credentials.ts` for `github` and `jira`. Open it for third-party plugins:

```typescript
// New exported function in @kuzo-mcp/core/credentials
export function registerClientFactory(
  service: string,
  factory: ClientFactory,
): void {
  if (clientFactories.has(service)) {
    throw new Error(
      `Client factory for service "${service}" is already registered`,
    );
  }
  clientFactories.set(service, factory);
}
```

Third-party plugins call this from their entry point's top-level (synchronous side-effect at module-import time — runs in the child process, but the broker also lives in the child after the 2.5d split). Plugins SHOULD register a factory if they want `access: "client"` mode for their credentials.

**Why this is acceptable security-wise:** the factory runs in the plugin's own process (after the 2.5d isolation split). The factory receives the scoped credential Map and the plugin logger. It returns an object. The plugin code can already do this manually — exposing it as a registered factory just standardizes the pattern and emits the audit event from the broker (`credential.client_created`) instead of from ad-hoc plugin code.

The hardcoded factories for `github` and `jira` continue to exist as defaults — third-party plugins can override them only by registering a different service name. There is no override-built-in mechanism.

### C.5 Shutdown scrub (Q15)

`EncryptedCredentialStore.close()`:

```typescript
close(): void {
  if (!this.cache) return;
  for (const key of this.cache.keys()) {
    // Best-effort: replace string with all-zero string of same length first
    // (V8 may have already interned/optimized; this is documented as best-effort hygiene)
    this.cache.set(key, "\0".repeat(this.cache.get(key)?.length ?? 0));
  }
  this.cache.clear();
  this.cache = undefined;
  this.auditLogger?.log({
    plugin: "kuzo",
    action: "credential.store_locked",
    outcome: "allowed",
    details: {},
  });
}
```

`DefaultCredentialBroker.shutdown?()`:

```typescript
shutdown(): void {
  for (const [key] of this.config) {
    this.config.set(key, "\0".repeat(this.config.get(key)?.length ?? 0));
  }
  this.config.clear();
}
```

**Best-effort note:** Node strings are immutable + V8 may have interned them; overwriting the map entry leaves the original UTF-16 buffer in heap until GC. This is documented hygiene, not a guarantee. The actual win is freeing the Map references so heap dumps post-shutdown don't surface the values via simple traversal.

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

`missing` now only includes credentials with `optional: false` (handled by `extractForPlugin`'s logic — only required caps contribute to `missing`). The legacy `extractV2Config()` helper in loader.ts can be deleted since `extractForPlugin` does the same work against `CredentialCapability` directly.

Constructor signature change for `PluginLoader`: new last arg `credentialSource: CredentialSource`. Existing callers in `server.ts` and parity-test fixtures must pass it. ConfigManager stays for non-credential config (`enabled` flags, future settings).

### C.7 `ConfigManager` simplification

Once credential extraction moves to `CredentialSource`, `ConfigManager.extractPluginConfig()` has no remaining callers. Delete the method. `loadDotenv()` stays — it still loads `.env` for non-credential config (`LOG_LEVEL`, eventually `KUZO_HOME` overrides if set there).

`loadDotenv()` is called by `ConfigManager`'s constructor at step 2 of the boot sequence — **before** we read `process.env` for credential overrides at step 5. So `.env`-supplied credentials show up as env overrides automatically. Good.

### C.8 Known gotchas

- **Don't put the scrub inside `loader.loadAll()`.** It must happen at the orchestrating layer (server.ts) so the loader stays agnostic about whether scrub is even desired (test code may want to disable it). The invariant must be visible at the call site.
- **Dotenv loads `.env` AT REQUIRE TIME of `ConfigManager`.** This means `process.env.GITHUB_TOKEN` is set after step 2 of the boot sequence, **before** we collect overrides at step 6. The scrub at step 7 catches it. But: if any code between steps 2 and 7 reads `process.env.GITHUB_TOKEN`, it sees the value. Audit the boot-sequence files in code review — currently nothing does, but it's a regression risk worth flagging.
- **`process.env` is shared across all in-process code.** Scrub affects EVERY module that reads `process.env.GITHUB_TOKEN` after step 7. That's intentional — but if a future feature wants the value, it must go through `CredentialSource.get()`, not `process.env`.
- **Child processes inherit `process.env` AT FORK TIME.** Scrub happens at boot, well before any `PluginProcess` forks. ✓ But: if a third party adds a new "fork before scrub" path (e.g. a background metric collector), the invariant breaks. Lint rule for `child_process.fork/spawn/exec` outside `PluginProcess.spawn()` is **out of scope** for v1 — document the invariant, add a smoke test that asserts `process.env.GITHUB_TOKEN === undefined` in a forked child during the boot-sequence smoke.
- **`KUZO_NO_ENV_SCRUB=1` is for dotenv-collision debugging only**, not for production. Emit a loud warning at boot when set.
- **Factory registration is a side-effect import.** Third-party plugins doing `registerClientFactory("foo", factoryFn)` at module top-level means import order matters — the factory is registered the first time the plugin module is loaded. Since loader dynamic-imports each plugin once, that's fine. Multiple registrations of the same service throw.
- **The third-party factory has full access to the scoped config Map.** That's by design — the factory IS plugin-controlled code. The security boundary is "factory cannot escape the plugin's process" (already enforced by 2.5d isolation) + "factory only receives the scoped credentials the plugin declared." Not "factory cannot see raw tokens." The brief's vector 2 is mitigated by the broker shape on first-party services; for third-party, the user must trust the plugin code (via Sigstore + consent) — same as for any installed npm package.

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
      process.exit(70);
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

### D.4 `runServer()` lifecycle (full sequence)

Already specified in §C.1. Restated as a checklist for D-acceptance:

1. **Install exit guard** — no SIGINT/SIGTERM handlers swallowed.
2. **Load `.env`** via `ConfigManager` — non-credential config available.
3. **Open consent/audit/credential store** — credential store is lazy (no decrypt yet).
4. **Collect env overrides** — `process.env.GITHUB_TOKEN` etc. captured into `envOverrides`.
5. **Scrub `process.env`** — captured keys deleted.
6. **Build `CredentialSource`** — env-override-first lookup ready.
7. **Load plugins** — `loader.loadAll()` constructs `PluginProcess` instances; **no plugin child forked yet** (lazy). First decrypt happens lazily when the first plugin's first tool call fires.
8. **Freeze prototypes** — per 2.5a; protects post-load runtime.
9. **Connect MCP transport** — server ready.
10. **On SIGINT/SIGTERM**: graceful shutdown — `loader.shutdownAll()` (closes plugin children), `registry.shutdownAll()`, `credentialStore.close()` (zeroes cache).

### D.5 Known gotchas

- **`kuzo` bin must be on `$PATH`.** For `npm install -g`, `pnpm add -g`, or `pnpm dlx` users this is automatic. For local-dev (`pnpm install` in repo), `packages/cli/dist/index.js` is the bin target; the user invokes via `pnpm exec kuzo serve` or `./node_modules/.bin/kuzo serve`. Document both. Claude.app's settings.json typically uses `command: "kuzo"` for global installs; the local-dev pattern is `command: "node", args: ["/path/to/cli/dist/index.js", "serve"]`.
- **Module resolution** — `await import("@kuzo-mcp/core/server")` in `serve.ts` must resolve the runtime-installed `@kuzo-mcp/core` package. With pnpm workspaces, that's automatic in dev (symlinked); installed-mode hits the user's `~/.kuzo/plugins/<name>/node_modules/@kuzo-mcp/core/` via the existing resolver. Verify with the parity test.
- **`--no-scrub` is debug-only.** Emit `process.stderr.write("WARNING: scrub disabled\n")` and an audit `credential.scrub_disabled` event on use. CI must reject `--no-scrub` in release-build smoke tests.
- **Top-level `await import` cost.** The `kuzo serve` entry point dynamic-imports `@kuzo-mcp/core/server` so the CLI binary doesn't pay the core's startup cost for `kuzo credentials list` etc. Static-imported `@kuzo-mcp/core/server` would force the full server module graph on every CLI invocation. Stick with dynamic import.
- **`runServer()` may throw before MCP connect.** Catch in `serveCommand.action` and exit non-zero with a friendly message (path 70). If it throws **after** MCP connect, the exit guard handles it.

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

**Refactors required**:

- `packages/core/src/consent.ts` — constructor signature stays (already accepts `consentDir`), but the default call site (`server.ts`) passes `kuzoHome()` instead of inline `join(homedir(), ".kuzo")`. The consent.ts internal default fallback (`options.consentDir ?? join(homedir(), ".kuzo")`) stays for backwards-compat callers but is functionally redundant once `server.ts` always passes the explicit dir.
- `packages/core/src/audit.ts` — same pattern as consent.
- `packages/cli/src/commands/plugins/paths.ts` — re-exports `pluginsRoot()` from `@kuzo-mcp/core/paths` (and any plugin-specific paths). Existing function names preserved for backwards-compat across the codebase.
- `packages/core/src/provenance/verify.ts` (or wherever TUF cache path is built) — uses `tufCacheDir()`.

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
- [ ] `kuzo plugins install` runs the inline-credential prompt for missing required credentials when interactive; respects `-y`.
- [ ] Audit log shows `credential.set` / `.deleted` / `.rotated` / `.migrated` / `.store_unlocked` / `.store_locked` events; no event includes the credential value.
- [ ] Shared lock at `~/.kuzo/.lock` prevents concurrent `kuzo plugins install` + `kuzo credentials set`.

**Part C — Broker**

- [ ] `runServer()` exported from `@kuzo-mcp/core/server`.
- [ ] Boot sequence smoke test asserts (a) overrides collected before scrub, (b) scrub happens before any plugin's `initialize()` is called, (c) `freezePrototypes()` runs after `loadAll`, (d) `credentialStore.close()` runs after `loader.shutdownAll()` on SIGTERM.
- [ ] `CredentialSource.get()` enforces env-override > store > undefined precedence.
- [ ] `KUZO_PASSPHRASE=...` set at boot: `KeyProvider` is `passphrase`; encrypted file decrypts.
- [ ] `KUZO_PASSPHRASE` unset, keychain populated: `KeyProvider` is `keychain`; one prompt on first decrypt.
- [ ] `KUZO_DISABLE_KEYCHAIN=1` without `KUZO_PASSPHRASE` errors loudly at boot (`E_NO_KEY_PROVIDER`, exit 71).
- [ ] `KUZO_NO_ENV_SCRUB=1` emits stderr warning + skips scrub; audit `credential.scrub_disabled` event.
- [ ] `registerClientFactory("foo", fn)` works from a third-party plugin and integrates with the broker's `getClient`.
- [ ] All existing 2.5b/c audit events (`credential.client_created`, `.raw_access`, `.raw_denied`, `.fetch_created`) continue to fire.

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
- [ ] `docs/STATE.md` — Phase 2.6 entry with PR refs; "Fresh-session handoff" plan advances to step 3 (real-life QA via Claude Code).
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
| F.7 | Lint rule banning `child_process.fork/spawn/exec` outside `packages/core/src/plugin-process.ts` to enforce Q5 invariant 5? | Defer — document in code review checklist; add post-2.6 if a regression occurs | Part C implementation |
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
- **`@napi-rs/keyring` supply chain risk.** Per A.9, the binding loads into every process. A compromised release reveals every stored credential. Mitigation: exact-version pin + manual bump review + the Sigstore provenance of `@kuzo-mcp/*` doesn't extend to deps. Live with the risk; the alternative (no keychain) is worse.
- **Settings.json rewrite breaking Claude Code.** Atomic rewrite + read-back-verify, but Claude Code parses settings.json on its own schedule. A migration that succeeds atomically but leaves Claude Code with a stale in-memory copy could lead to confusion. Mitigation: migration command's final line is "Restart Claude Code to pick up the new MCP server entry." Document.
- **Race between in-progress plugin install and credential write.** Shared lock at `~/.kuzo/.lock` prevents this. Verified by smoke (open two terminals, attempt concurrent `kuzo plugins install foo` and `kuzo credentials set X`; one waits or fails with exit 30).
- **Encrypted file format v1 lock-in.** Adding fields to the JSON payload is forward-compatible (decryption just sees extra fields). Changing the header layout requires a new magic and a migration path. Keep v1 simple; bump magic to "KCR2" only if forced.
- **Loss of master key.** If the user wipes their keychain (`security delete-generic-password -s kuzo-mcp`), `credentials.enc` becomes undecryptable. There is no recovery — the file is encrypted with that one key. Document: "Master key loss = all stored credentials lost. Run `kuzo credentials list --json` periodically to know what to re-provision, or stay in env-override mode if rotation is frequent."

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

**Spec locked 2026-05-10.** Implementation per the cutover plan in §F.3. Edits to the design land in PR diffs to this file, not in `docs/credentials-spec-brief.md` (which is the historical input).
