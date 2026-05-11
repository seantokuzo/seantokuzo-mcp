# Phase 2.6 Credentials Spec — Round 3 Remediation Notes

> Hand-off for a fresh session to apply round-3 revisions to `docs/credentials-spec.md` (1426 lines, currently uncommitted). Three independent reviewers (security/crypto, architecture/contract, UX/implementability) ran in parallel against the spec and the existing code base. **All three returned "not safe to implement as-is."** This document is the deduplicated, prioritized fix list with status verdicts.

**Status:** Round-2 spec landed 2026-05-10 → reviews ran 2026-05-10 → these notes 2026-05-10. Next session executes.

**Verdict:** 23 BLOCKING + 26 ADVISORY + 24 NIT findings (73 total). No reviewer contradictions — they push toward the same fixes from different lenses. Most BLOCKING items are textual rewrites of specific spec sections; four (R1, R7, R12, R14) require structural decisions called out in §Structural decisions at the end.

---

## How to use this document

- **Numbered items R1–R44**, severity-tagged `[BLOCKING]` / `[ADVISORY]` / `[NIT]`.
- **Source** indicates which reviewer raised it (`SEC`, `ARCH`, `UX`) and their finding number. Where multiple reviewers converged, all are cited.
- **Spec section** points at the section to edit.
- **Status verdict** is the round-3 author's (Sean) intent — `ACCEPT`, `PARTIAL` (with reasoning), or `REJECT` (with reasoning). Items marked `STRUCTURAL` require the user to confirm direction before the fresh session can implement.
- **Recommended execution order** is theme-grouped (Themes 1→9). Within a theme, follow numerical order.

---

## Recommended round-3 execution order

1. **Theme 1: Boot sequence & decrypt model** (R1-R6) — settle parent-eager vs child-lazy first; everything else depends on it.
2. **Theme 2: Scrub coverage** (R7-R10) — once boot sequence is settled, lock down what's scrubbed and when.
3. **Theme 3: Cryptographic correctness** (R11-R15) — scrypt params, AAD binding, honest key-zeroing language.
4. **Theme 4: Audit log writer trust** (R16-R17) — must land before any new write-side audit events go live.
5. **Theme 5: Migration command hardening** (R18-R23) — symlink-safe rewrite, idempotent re-run, dry-run UX.
6. **Theme 6: Code grounding & contract gaps** (R24-R32) — make the spec's claims match the existing code.
7. **Theme 7: User journey + CLI surface** (R33-R40) — add `credentials test`, exit codes table, upgrade banner, preAction fix, parity setup, CI guidance.
8. **Theme 8: Documentation** (R41-R43) — README outline, --help mockups for migrate/status.
9. **Theme 9: Nits** (R44) — final consistency pass.

After applying R1-R44, re-read the spec end-to-end. Expected delta: +400 to +600 lines, ending around 1700-1900 lines.

---

## Theme 1 — Boot sequence & decrypt model

### R1 [BLOCKING] [STRUCTURAL] Pick parent-eager decrypt model; rewrite §C.1 + §C.3

**Source:** ARCH B1 (load-bearing); SEC #2/#3 (downstream consequence).
**Spec section:** §C.1 step 4 + §C.3 + every reference to "lazy decrypt" / "first getClient triggers prompt."

**Problem:** The spec claims (a) the store is lazy, (b) first `getClient` triggers the keychain prompt, (c) "one prompt per Node lifetime," (d) scrub runs before any plugin can read `process.env`. These can't all hold given the 2.5d isolation model. The `DefaultCredentialBroker` is constructed in the *child* (`plugin-host.ts:114`), and the per-plugin credential Map is serialized to the child via IPC at fork time. The parent must populate that Map at `loader.loadAll()` time — which means the parent must decrypt at boot, not lazily.

**Fix:** Pick **Model A — parent-eager decrypt after scrub, only if any plugin requires a stored credential.**

Rewrite §C.1 step 4 + §C.3 to specify:
- Parent constructs `EncryptedCredentialStore` at boot but does NOT call `KeyProvider.acquireKey()` yet.
- After scrub (step 7), `extractForPlugin` is the trigger that calls `credentialSource.get()` — which calls `credentialStore.get()` for any key not satisfied by env override.
- The FIRST `store.get()` call (across all plugins) triggers `KeyProvider.acquireKey()` and decrypts the blob into a parent-side cache. All subsequent reads hit the cache.
- If every plugin's required credentials are satisfied by env overrides, the store is never decrypted, the keychain is never touched. The "one prompt per Node lifetime" claim becomes "zero or one prompt per Node lifetime depending on whether any plugin's required credentials come from the store."
- The Map sent to each child via IPC contains ONLY the resolved credential values for that plugin. The child reconstructs `DefaultCredentialBroker` from that Map. The child has no `KeyProvider` and no access to `credentials.enc`.

**Status:** STRUCTURAL — confirm Model A before fresh session executes. The alternative (Model B: ship `KeyProvider` config to each child) is rejected because each child would trigger its own keychain prompt, breaking the entire UX win. Model C (revert 2.5d isolation) is off the table. Sean confirms Model A.

---

### R2 [BLOCKING] Fix `PluginLoader` constructor arg order in §C.1 example

**Source:** ARCH B2.
**Spec section:** §C.1 step 9 code block.

**Problem:** Spec example passes `(configManager, registry, logger, consentStore, auditLogger, credentialSource)`. Actual constructor at `loader.ts:38-44` is `(registry, configManager, logger, consentStore, auditLogger)`. The example won't typecheck.

**Fix:** Use `(registry, configManager, logger, consentStore, auditLogger, credentialSource)`. Note in §F.1 acceptance that the parity test boots via `node packages/core/dist/server.js`, not direct construction, so it's unaffected — but any test fixture constructing `PluginLoader` directly needs the update.

**Status:** ACCEPT.

---

### R3 [BLOCKING] Specify how `collectDeclaredCredentialEnvNames` reads manifests (no dynamic-import pre-scrub)

**Source:** SEC #3.
**Spec section:** §C.1 step 5.

**Problem:** Step 5 says "peeks at the kuzo.config.ts plugin list + their manifests, NO plugin init yet" — but "peeking at manifests" implies dynamic-importing the plugin module, which executes its top-level code. Plugin manifests can include top-level imports that spawn helpers or read `process.env` directly. Running pre-scrub means a malicious plugin's manifest can exfil before step 7 fires.

**Fix:** Rewrite §C.1 step 5 to specify the manifest data source is static:
- For installed plugins, read `~/.kuzo/plugins/<name>/current/pkg/package.json`'s `kuzoPlugin` block, which already declares the plugin's capabilities (the `kuzoPlugin` metadata block, inert since 2.5e A.5).
- For dev-mode plugins, read each `packages/plugin-*/package.json` directly.
- NO `import()` of plugin entry modules before the scrub completes.
- Add to §C.8 known gotchas: "Plugin manifest data for the pre-scrub boot step comes from `package.json#kuzoPlugin` only. Plugin entry modules are never loaded before scrub. If a plugin's runtime manifest (the V2 `KuzoPluginV2` object) declares a capability not in `package.json#kuzoPlugin`, the loader will skip it with `plugin.failed: manifest_drift`."

**Status:** ACCEPT. Note: this implies a new acceptance criterion in §F.1: "plugins whose `package.json#kuzoPlugin.capabilities` drifts from their runtime manifest are skipped, not loaded."

---

### R4 [BLOCKING] Move the lint rule for `child_process` from §F.7 to Part C as MUST-LAND

**Source:** SEC #3 (part of the same finding).
**Spec section:** §F.7 (move out of "deferred") + new §C.9 subsection.

**Problem:** Invariant 5 ("no `child_process.fork/spawn/exec` between `ConfigManager` construction and the scrub") is enforced by hope. Spec defers the lint rule to a post-2.6 follow-up. With third-party plugins shipping module top-level code that can fork, deferring is wrong.

**Fix:** New ESLint rule in `eslint.config.js`, scoped to `packages/core/src/server.ts` and `packages/core/src/loader.ts`: ban `child_process.{fork,spawn,exec,execFile,execSync,spawnSync,execFileSync}` imports/calls. Allow only via the `plugin-process.ts` IPC path (whitelist via `files:` scope override). New acceptance criterion in §F.1: "Synthetic test plants a `child_process.fork` call in `server.ts` and asserts the lint rule flags it red." Document in §C.8 gotchas.

**Status:** ACCEPT. Move from F.7 deferred → Part C must-land. Update build order in §0 (Theme 1 step) to include the lint rule.

---

### R5 [BLOCKING] `chooseKeyProvider()` must not trigger keychain side effects pre-scrub

**Source:** ARCH B7.
**Spec section:** §A.5 + §C.1 step 4.

**Problem:** `chooseKeyProvider()` in §A.5 returns either `KeychainKeyProvider` or `PassphraseKeyProvider`. The `KeychainKeyProvider` constructor does `new Entry("kuzo-mcp", "master-key")` which on Linux may invoke dbus side effects. The provider construction is at step 4, before the step 7 scrub.

**Fix:** Make `KeyProvider` constructors strictly inert. Move all keychain/scrypt side effects into `acquireKey()` and `initializeKey()` (the only methods that actually touch the keychain). Add to §A.5: "**Constructor side-effect freedom invariant:** `new KeychainKeyProvider()` and `new PassphraseKeyProvider(passphrase)` perform NO I/O, NO dbus calls, NO Keychain Services calls. Only `acquireKey()`/`initializeKey()` may invoke external systems."

**Status:** ACCEPT.

---

### R6 [BLOCKING] Preserve `server.ts` self-invocation for `start:mcp` + parity test

**Source:** ARCH B6.
**Spec section:** §C.1 + §D.1.

**Problem:** Spec turns `server.ts`'s top-level `main()` into an exported `runServer()` function. But `pnpm start:mcp` is `node packages/core/dist/server.js` (no `runServer()` call) and the parity test (`scripts/test-install-parity.mjs:115-119`) does the same. Without a self-invocation guard, both break.

**Fix:** End of `packages/core/src/server.ts` keeps a self-invocation guard:

```typescript
// Module entry — invoke when this file is the process entry point.
// `kuzo serve` (CLI) imports `runServer` directly and skips this branch.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runServer().catch((err) => {
    process.stderr.write(`kuzo server failed: ${(err as Error).message}\n`);
    process.exit(70);
  });
}
```

Document in §D.5 known gotchas: "Both `kuzo serve` and `node packages/core/dist/server.js` boot the same `runServer()` — one via import, one via the self-invocation guard. The parity test continues to use the latter."

**Status:** ACCEPT.

---

## Theme 2 — Scrub coverage

### R7 [BLOCKING] [STRUCTURAL] Scrub `KUZO_PASSPHRASE` from `process.env` after key derivation

**Source:** SEC #2.
**Spec section:** §A.5 (`PassphraseKeyProvider`) + §A.7 (`scrubProcessEnv`).

**Problem:** `PassphraseKeyProvider` stashes `passphrase: string` as a readonly field for server lifetime. After `acquireKey` derives and caches the 32-byte AES key, the passphrase is dead weight that's still heap-reachable + still in `process.env.KUZO_PASSPHRASE`. A malicious plugin loaded post-boot in the parent (e.g., a third-party plugin's manifest dynamic-import in a future feature) reads `process.env.KUZO_PASSPHRASE` → re-derives key → decrypts blob. Vector 2 silently broken in passphrase mode.

**Fix:**
1. Add `"KUZO_PASSPHRASE"` to the unconditional-scrub list in `scrubProcessEnv` (separate from `scrubKeys`, always deleted regardless).
2. In `PassphraseKeyProvider.acquireKey` / `.initializeKey`, immediately overwrite the `passphrase` field after the scrypt derivation completes: `(this as any).passphrase = "\0".repeat(this.passphrase.length); (this as any).passphrase = undefined;`. Honest acknowledgment: V8 string interning means the original may persist in heap until GC; this is hygiene, not guarantee. Document as such.
3. Add to §C.8 known gotchas: "`KUZO_PASSPHRASE` is unconditionally scrubbed (not via declared-env-names). The kill-switch `KUZO_NO_ENV_SCRUB=1` does NOT exempt `KUZO_PASSPHRASE` — kill-switch is for dotenv-library debugging only."

**Status:** STRUCTURAL — sub-decision: do we want a `KUZO_KEEP_PASSPHRASE=1` escape hatch for users who rotate Node binaries and want to re-derive without re-prompting? Recommend **no** (re-derivation requires re-prompt, which is fine — argues for hybrid + keychain on macOS instead). Sean confirms no escape hatch.

---

### R8 [ADVISORY] Audit-emit a `credential.passphrase_consumed` event when `PassphraseKeyProvider.acquireKey` succeeds

**Source:** SEC #2 (related).
**Spec section:** §B.7 audit union + §A.5 implementation.

**Problem:** A passphrase mode boot has no audit trail of "the passphrase was used and consumed." Useful for the threat-vector-7 user who wants to know "did anything use my passphrase today?"

**Fix:** Add `"credential.passphrase_consumed"` to `AuditAction` union (§B.7). Emit from `PassphraseKeyProvider.acquireKey` post-derivation. Details: `{provider: "passphrase", salt_fingerprint: sha256(salt).slice(0, 16)}`. Never the passphrase itself.

**Status:** ACCEPT.

---

### R9 [BLOCKING] `kuzo credentials set` against missing keychain entry must NOT silently rotate the master key

**Source:** SEC #4.
**Spec section:** §A.3 write path + §A.5 + new §A.11 state machine.

**Problem:** Today's spec: `acquireKey()` throws on missing entry; `initializeKey()` unconditionally writes fresh key. If the user runs `kuzo credentials set` after their keychain entry was deleted (manually OR by local malware), the implementation has to choose. The natural read of A.3's write-path is "acquire first" — which throws. The implementer reaches for `initializeKey()` → silently rotates the master key → existing `credentials.enc` is now undecryptable.

**Fix:** Add explicit state-machine in new §A.11:

| Master-key entry | `credentials.enc` | State | Action |
|---|---|---|---|
| Present | Absent | Fresh-with-key | Use existing key; create file on first set |
| Absent | Absent | Fresh | Initialize key; create file on first set |
| Present | Present | Steady-state | Use existing key + file |
| Absent | Present | **KEY LOST** | Refuse; exit 72 (`E_KEY_LOST`); error message tells user `kuzo credentials wipe --confirm` to start over OR restore keychain |
| Tamper (decrypt fails) | n/a | **CORRUPTED** | Refuse; exit 73 (`E_FILE_CORRUPTED`); same `wipe` instructions |

`kuzo credentials wipe --confirm` is a new subcommand that nukes both the file and the keychain entry. NOT a quiet path — requires `--confirm` exactly (no `-y`), prints "this destroys all stored credentials, are you sure (type 'yes')." Audit-emits `credential.wiped`.

**Status:** ACCEPT. Update §B.1 command surface table to add `wipe`. Add `credential.wiped` to §B.7 audit union.

---

### R10 [ADVISORY] `KUZO_DISABLE_KEYCHAIN=1` without `KUZO_PASSPHRASE` must allow env-override-only boot

**Source:** ARCH A5.
**Spec section:** §A.5 `chooseKeyProvider()`.

**Problem:** Spec logic: `KUZO_DISABLE_KEYCHAIN=1` requires `KUZO_PASSPHRASE` or errors. But a CI runner with `op run --` injecting all credentials wants ZERO storage and ZERO keychain. Forcing a dummy `KUZO_PASSPHRASE` leaks into shell history.

**Fix:** Introduce `NullKeyProvider` (kdfId `0xFF`). Selection logic:

```typescript
if (process.env.KUZO_DISABLE_KEYCHAIN === "1") {
  if (process.env.KUZO_PASSPHRASE) {
    return new PassphraseKeyProvider(process.env.KUZO_PASSPHRASE);
  }
  // env-override-only mode: no store backing
  return new NullKeyProvider();
}
```

`NullKeyProvider.acquireKey()` throws `E_NO_STORAGE` ("attempted to read from credential store but storage is disabled"). The store's `get()` MUST never call `acquireKey()` when the file does not exist — short-circuits to `undefined`. So in env-override-only mode, `store.get("GITHUB_TOKEN")` returns undefined for everything, `CredentialSource` falls back to env overrides, and life works.

**Status:** ACCEPT. Update §A.5 logic + add `NullKeyProvider` to the implementations list.

---

## Theme 3 — Cryptographic correctness

### R11 [BLOCKING] Fix scrypt `maxmem` parameter — currently provably broken

**Source:** SEC #1 (empirically verified).
**Spec section:** §A.2 + §A.5.

**Problem:** Spec says `maxmem: 64 * 1024 * 1024`. scrypt with `N=2^17 r=8 p=1` requires ~128 MiB. Node throws `Invalid scrypt params: memory limit exceeded`. Every Linux-headless / CI boot in passphrase mode crashes. The "Verified locally" claim was wrong.

**Fix:** Set `maxmem: 256 * 1024 * 1024` (slack above the 128 MiB requirement). Add acceptance criterion in §F.1: "Unit test round-trips `PassphraseKeyProvider.initializeKey() → acquireKey()` with the production scrypt params; failure to allocate is a regression."

**Status:** ACCEPT.

---

### R12 [BLOCKING] [STRUCTURAL] Bind file identity into AAD to defeat backup-rollback attack

**Source:** SEC #7.
**Spec section:** §A.3 file format + AAD coverage.

**Problem:** Current AAD covers `magic|version|kdfId|kdfParams`. Attacker (vector 1) with FS write access swaps `credentials.enc` with a Time Machine backup from before token rotation. Magic matches, key matches, AAD matches → decrypt succeeds → rotation rolled back. The user thinks their rotation took effect; the old token is still valid.

**Fix:** Add a **generation counter** in the keychain entry. The keychain stores `{key: base64, generation: number}` (still single entry; the value is now a 2-field JSON blob). Every successful write bumps the counter. AAD includes `generation`. Restoring an old `credentials.enc` whose generation < current keychain generation fails AAD verification.

Legitimate recovery flow ("I rebuilt my Mac, kept Time Machine restore"): `kuzo credentials wipe --confirm` zeros the keychain entry; re-import via `kuzo credentials migrate` from source files OR re-provision via `kuzo credentials set`. We're choosing rollback-attack-resistance over backup-restore-cheapness. Document tradeoff in §F.4 risks.

**Pushback considered:** SEC's original suggestion was to include a `sha256("kuzo-mcp/credentials.enc/v1")` static identity string in AAD. That defeats one attack class (renaming a totally-foreign file to `credentials.enc`) but NOT the in-place backup-rollback. Generation counter defeats both. Adopt the stronger fix.

**Status:** STRUCTURAL — confirm we want rollback-attack-resistance even at the cost of harder backup recovery. Sean confirms yes (single-user device, FS-write malware is a real vector, generation counter is cheap).

---

### R13 [ADVISORY] Drop dishonest "zero-fill" language; use `Buffer` for master key + plaintext map values where it costs nothing

**Source:** SEC A5; ARCH NIT (multiple).
**Spec section:** §C.5 + §A.4 + §B.7.

**Problem:** Spec claims `credentialStore.close()` "zeroes the in-memory cleartext map" via `"\0".repeat(value.length)` assignment. V8 strings are immutable + interned; the assignment creates a fresh string and leaves the original UTF-16 buffer reachable until GC. The audit-event `credential.store_locked` implies a guarantee the code doesn't provide.

**Fix:** Two-part:
1. **Master key:** stored as `Buffer` in `KeyProvider` cache (already so in the spec's example code). After `close()`, `key.fill(0)` actually overwrites bytes. **This much is real.** Keep it.
2. **Plaintext credential map:** strings. Drop the `"\0".repeat()` theater. Just `this.cache.clear()` + `this.cache = undefined`. Down-grade audit-event details to `{count: priorCount}` instead of implying zeroing.
3. Update spec text in §C.5: "the master key Buffer is zeroed via `Buffer.fill(0)`; the plaintext credential map is dereferenced via `Map.clear()`. V8 string interning means individual credential strings may persist in heap until GC — this is hygiene, not a tamper-evidence guarantee."
4. **Optional v2 improvement (out of scope for round 3):** store credential values as `Buffer` end-to-end. Requires changing `CredentialStore.get(): string | undefined → Buffer | undefined` everywhere downstream. Big refactor; defer.

**Pushback considered:** SEC suggested option (b) "require Buffer storage for credential values throughout." That's an interface change touching the broker, the plugin context, every plugin's `getClient` factory. Too much for round 3. Take the honest-language path and defer the deeper refactor.

**Status:** PARTIAL — accept (1)-(3), reject the v2 Buffer-everywhere refactor as out of scope. Add a §F.2 open question: "Should credential values become `Buffer` end-to-end for true zero-fillable lifecycle? Defer to a follow-up phase."

---

### R14 [BLOCKING] [STRUCTURAL] Strengthen supply-chain dep policy beyond just `@napi-rs/keyring`

**Source:** SEC A4.
**Spec section:** §A.9.

**Problem:** Spec pins `@napi-rs/keyring` exactly + manual review on every bump. But `commander`, `inquirer`, `dotenv` are equally privileged for credential handling (commander parses CLI flags, inquirer prompts for the password, dotenv loads `.env`). None are pinned exact.

**Fix:** Tiered dep policy:

| Tier | Packages | Policy |
|---|---|---|
| **1 — Credential-mediating** | `@napi-rs/keyring` | Exact pin (no `^`). Manual review per bump. Checksum the napi prebuilt binary against the GitHub release. |
| **2 — Secret-touching** | `inquirer`, `commander`, `dotenv` | Caret-range pin (`^X.Y.Z`). Dependabot enabled; bumps reviewed in their own PR with CHANGELOG diff. NOT manual review per release. |
| **3 — Standard runtime deps** | everything else (`pacote`, `sigstore`, etc.) | Caret-range. Dependabot auto-merge on green CI for patch bumps. |

The distinction: Tier 1 native binding has total blast radius and zero JS-level defense. Tiers 2 and 3 are auditable JS code with established review patterns.

**Pushback considered:** SEC suggested "pin commander + inquirer + dotenv exactly, verify the napi binary checksum on every bump." Pinning Tier 2 exactly blocks every dependabot bump and creates pain that doesn't pay off — inquirer/commander/dotenv are JS-only with no native deps, their attack surface is bounded by code review. Don't conflate "secret-touching" with "secret-mediating-via-native-binding."

**Status:** STRUCTURAL — confirm the tiering. Sean confirms.

---

### R15 [ADVISORY] AAD format-stability + payload version note

**Source:** ARCH A7; SEC NIT.
**Spec section:** §A.3.

**Problem:** Spec doesn't note that any future header-field addition forces a magic bump (`KCR1` → `KCR2`) because AAD bytes change. A maintainer might naively add a "comment byte" at offset 5 and break every existing file.

**Fix:** Add to §A.3: "**Header immutability rule:** any change to the header byte layout — including adding a single byte between magic and ciphertext — invalidates all existing files (AAD bytes change → GCM verification fails). Header changes MUST bump magic to `KCR2`+ and ship a migration that reads `KCR1` → re-encrypts as `KCR2`. The plaintext JSON payload, by contrast, is forward-compatible: new fields are ignored by old readers; missing fields are treated as defaults."

**Status:** ACCEPT.

---

## Theme 4 — Audit log writer trust

### R16 [BLOCKING] [STRUCTURAL] Route plugin-host audit emissions through IPC to parent

**Source:** SEC #5.
**Spec section:** New §C.10 + §B.7 + existing `plugin-host.ts:113` / `audit.ts`.

**Problem:** Today every plugin child runs `appendFileSync(~/.kuzo/audit.log)` directly. The `plugin` field is whatever the caller supplies — no PID check, no identity verification. My round-2 spec adds high-trust write-side events (`credential.set`, `.rotated`, `.migrated`, etc.) which are byte-indistinguishable from forgeries written by a malicious plugin child. Threat vector 7 (audit trail integrity under plugin compromise) is silently broken.

**Fix:** Re-architect audit emission:
1. The CLI (`kuzo credentials *`) writes audit events directly — those are in the parent / interactive shell, trust boundary is the user.
2. The MCP server's `runServer()` parent writes audit events directly — same trust boundary.
3. The plugin-host (child) STOPS writing to `audit.log` directly. Instead it sends an IPC notification to the parent: `{type: "audit", event: {...}}`. Parent receives, **stamps `event.pid` with the child PID** (overwriting any caller-supplied value), and writes.
4. The parent's IPC receiver MUST validate that `event.plugin` matches the child's declared plugin name (the parent already knows this from `PluginProcess` ownership). Mismatched plugin field → log as `audit.forged_plugin_field` with both values and continue.

Add to §F.1 acceptance: "Synthetic test plants a malicious plugin that emits an audit event claiming `plugin: 'kuzo'` (impersonating core); test asserts the entry is logged as `audit.forged_plugin_field` with the real child PID, not as the impersonated entry."

**Status:** STRUCTURAL — this is a real chunk of work (modifies `plugin-host.ts`, `plugin-process.ts`, `audit.ts`). Confirm we're doing it now vs. deferring. **Recommend doing it now** — every new write-side event compounds the problem.

---

### R17 [ADVISORY] Add `credential.scrub_disabled` to AuditAction union

**Source:** UX A7 + SEC (related).
**Spec section:** §B.7.

**Problem:** Spec §D.5 says emit `credential.scrub_disabled` audit event when `--no-scrub` is used, but the event isn't in §B.7's `AuditAction` union. TypeScript would reject the emit.

**Fix:** Add `"credential.scrub_disabled"` to the union. Reconcile the warning text between §C.1 (`logger.warn(...)`) and §D.5 (`process.stderr.write(...)`); pick one — use `logger.warn` (consistent with rest of boot sequence logging).

**Status:** ACCEPT.

---

## Theme 5 — Migration command hardening

### R18 [BLOCKING] Symlink-safe `migrate` source rewrite

**Source:** SEC #6.
**Spec section:** §B.4.

**Problem:** §B.4 atomically rewrites `~/.claude/settings.json` via tmp+rename. No `lstat`/`O_NOFOLLOW`/`S_ISREG` check. Attacker (vector 1) can replace `settings.json` with a symlink to an attacker-chosen path; our rename clobbers wherever the symlink points.

**Fix:** Pre-rewrite checks for every source file (settings.json + each `.env`):
1. `fs.lstat(path)` — fail with `E_SYMLINK_REFUSE` (exit 74) if `isSymbolicLink()`.
2. `fs.stat(path)` — fail with `E_NOT_REGULAR_FILE` (exit 75) if not `isFile()`.
3. Open with `fs.open(path, "r")` + `fs.fstat(fd)` and compare `st_dev/st_ino` to the lstat result — fail if changed (race).
4. After tmp-write + rename, `fs.fsync` the file AND `fs.fsync` the containing directory's fd.
5. On Linux, pass `O_NOFOLLOW` to `fs.openSync` for the read AND for the tmp write.

Document in §B.4 known gotchas.

**Status:** ACCEPT.

---

### R19 [BLOCKING] Editor-collision detection during migration

**Source:** SEC #6 (sub-finding).
**Spec section:** §B.4.

**Problem:** User's editor (VSCode, vim) has `settings.json` open. We read content for migration; user types other unrelated edits; we tmp-write + rename; their next save clobbers our redaction OR our rename clobbers their edits.

**Fix:** Add snapshot-compare just before rename:
1. After tmp-write, re-read the source file content into memory.
2. Byte-compare against the snapshot taken at the start of migration.
3. If different, abort with `E_SOURCE_MUTATED` (exit 76) and instruct: "the source file was modified during migration; close your editor and retry."
4. Document in §B.4 + §B.8: "Migration is short-lived but assumes the source file is not being concurrently edited. Close your editor's settings.json window before running."

**Status:** ACCEPT.

---

### R20 [BLOCKING] Idempotent migrate re-run semantics

**Source:** UX A4/A5; ARCH (related).
**Spec section:** §B.4 (new subsection "Re-run semantics").

**Problem:** Spec describes happy-path flow but doesn't define idempotent behavior. What happens if:
- Run 1 imports 3 creds, rewrites `.env` (success), rewrites `settings.json` (fail).
- Run 2: `.env` already redacted, `settings.json` still has the values, the store has all three.
- Does run 2 try to import them again? Re-attempt rewrite-only? Spec is silent.

**Fix:** Add §B.4 "Re-run semantics" subsection:
1. Source-file rewrite is attempted **independently per source** of import.
2. For each source: if any matching key is present in the source file AND that key is present in the store with the **same value** AND the source still contains the value in cleartext → enqueue a rewrite (no import needed).
3. If the key is present in the source but the stored value differs → `E_CONFLICT` (exit 77); user must resolve manually via `kuzo credentials set <name>` (interactive) or `--force-source` flag (overwrites store with source value).
4. Print summary distinguishing newly-imported vs. rewrite-only operations.
5. Document in §B.4 example: "Re-running `kuzo credentials migrate` is safe. Each source file is processed independently. Already-stored credentials are not re-imported but their source-file redaction is still attempted."

**Status:** ACCEPT. Add `E_CONFLICT` (77) to exit codes table (R36).

---

### R21 [ADVISORY] Migrate `--dry-run` must NOT trigger keychain prompt

**Source:** ARCH A4.
**Spec section:** §B.4.

**Problem:** Spec says `--dry-run` "shows what would change; touch nothing." But to "skip if already stored AND existing value matches," it needs to decrypt → keychain prompt fires. On macOS that's a user-visible modal which technically isn't a write but feels mutating.

**Fix:** `--dry-run` skips the equality check entirely. Lists candidate keys as "would import" if present in source, regardless of store state. Document: "`--dry-run` reports the maximum set of changes; an actual run may skip already-stored matching values silently."

**Pushback considered:** Reviewer suggested also avoiding the decrypt by other means. Simpler: just bypass the comparison in dry-run. Real run still does the proper compare.

**Status:** ACCEPT.

---

### R22 [ADVISORY] Bound `.env` ancestor walk + require explicit kuzo-mcp marker

**Source:** SEC A6.
**Spec section:** §B.4.

**Problem:** Walking cwd ancestors for `.env` with `package.json containing "@kuzo-mcp/cli"` is loose:
- No max-depth bound (could walk to `/`).
- "Containing the substring" matches anything that mentions the package in `description`, `keywords`, etc.

**Fix:** Bound the walk:
1. Max 5 ancestor levels from cwd.
2. Stop at the user's `$HOME` boundary (don't walk above home).
3. `package.json` must declare `@kuzo-mcp/cli` (or any `@kuzo-mcp/*`) in `dependencies`, `devDependencies`, OR `peerDependencies` — not in any other field.
4. Skip `.env` files outside `$HOME` (e.g., `/.env`, `/etc/.env` — never imported).
5. Document in §B.4: "`.env` scanning only considers files within `$HOME`, in repositories declaring `@kuzo-mcp/*` as a dep, up to 5 ancestor directories."

**Pushback considered:** SEC suggested "require `@kuzo-mcp/*` declared as a dep" which I'm adopting. The 5-level + $HOME bounds are belt-and-suspenders.

**Status:** ACCEPT.

---

### R23 [ADVISORY] Migration partial-failure UX: explicit per-key instruction

**Source:** UX A4/A5.
**Spec section:** §B.4 output format.

**Problem:** "Manually remove the entry from that file" is too vague when the user is staring at JSON. They might delete the entire `kuzo` mcpServers block.

**Fix:** Partial-failure prints exact instructions per failed source:

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

**Status:** ACCEPT.

---

## Theme 6 — Code grounding & contract gaps

### R24 [BLOCKING] [STRUCTURAL] Move `registerClientFactory` onto `PluginContext`, off `@kuzo-mcp/core/credentials`

**Source:** ARCH B3.
**Spec section:** §C.4.

**Problem:** Spec exports `registerClientFactory` from `@kuzo-mcp/core/credentials`. That subpath isn't in `packages/core/package.json` exports today AND the brief's constraint #5 explicitly forbids plugins from importing core internals directly.

**Fix:** Add factory registration to `PluginContext.credentials`:

```typescript
interface CredentialBroker {
  // ... existing methods
  /**
   * Register a factory for this plugin's primary service.
   * Plugin must declare `access: "client"` for the service's credentials in its manifest.
   * Idempotent: registering the same `(plugin, service)` pair twice is a no-op.
   * Cross-plugin override (e.g., plugin "foo" registering for service "github") is rejected.
   */
  registerClientFactory<T>(service: string, factory: (config: Map<string, string>, logger: PluginLogger) => T | undefined): void;
}
```

Plugins call from `initialize()`:

```typescript
async initialize(context: PluginContext) {
  context.credentials.registerClientFactory<MyClient>("my-service", (config, logger) => {
    const token = config.get("MY_TOKEN");
    if (!token) return undefined;
    return new MyClient({ token, logger });
  });
  const client = context.credentials.getClient<MyClient>("my-service");
  // ...
}
```

The broker (which lives in the child) holds the registration. First-party factories (`github`, `jira`) are pre-loaded into every broker instance at construction. Cross-plugin registration is forbidden — plugin name passed via broker constructor pins the `service ↔ plugin` relationship.

**Status:** STRUCTURAL — confirm. Sean confirms.

Update §C.4 to remove the `@kuzo-mcp/core/credentials` import path. Update §A.5 to add `registerClientFactory` to the `CredentialBroker` interface in `packages/types/src/index.ts`.

---

### R25 [BLOCKING] Wire `broker.shutdown()` in `plugin-host.ts`, not `server.ts`

**Source:** ARCH B4.
**Spec section:** §C.5.

**Problem:** Spec says `server.ts` shutdown invokes `broker.shutdown?()`. But the broker lives in the child process; the parent never holds a reference. The call would be a no-op.

**Fix:** Modify `packages/core/src/plugin-host.ts`'s `handleShutdown()`:

```typescript
async function handleShutdown() {
  try {
    await plugin.shutdown?.();
  } catch (err) {
    logger.error(`plugin shutdown failed: ${err}`);
  }
  if (broker && typeof (broker as any).shutdown === "function") {
    (broker as any).shutdown();
  }
  setTimeout(() => process.exit(0), 100);
}
```

`server.ts` shutdown handler only calls `credentialStore.close()` on the parent-side cache (per R1's parent-eager model). Document in §C.5: "Parent zeros its decrypted-blob cache via `credentialStore.close()`. Each child zeros its scoped credential Map via `broker.shutdown()` in plugin-host."

**Status:** ACCEPT.

---

### R26 [BLOCKING] Complete `~/.kuzo` refactor inventory in §E.2

**Source:** ARCH A2.
**Spec section:** §E.2 + §F.1.

**Problem:** Spec lists consent.ts, audit.ts, plugins/paths.ts, provenance/verify.ts as refactor sites. Missed:
- `packages/core/src/plugin-resolver.ts:71` — `process.env["KUZO_PLUGINS_DIR"] ?? join(homedir(), ".kuzo", "plugins")`.
- `packages/core/src/plugin-process.ts:161` — `--allow-fs-read=${pluginFsPath},${homedir()}/.kuzo/` (Node permission flag).
- `packages/cli/src/commands/plugins/refresh-trust-root.ts:34` — local `kuzoHome` shadowing the future imported helper.

**Fix:** Update §E.2 to enumerate all five sites with line numbers. Add §F.1 acceptance: "Grep for `homedir()` AND `.kuzo` in the same file across the entire codebase returns zero matches outside `packages/core/src/paths.ts`."

**Status:** ACCEPT.

---

### R27 [ADVISORY] Lock-path migration — handle cross-version concurrency during upgrade

**Source:** ARCH B5.
**Spec section:** §B.6 + new §B.6.1 "upgrade concurrency."

**Problem:** Moving the lock from `~/.kuzo/plugins/.lock` to `~/.kuzo/.lock`. During the 0.0.2→0.1.0 upgrade window, a `kuzo plugins install` from 0.0.2 acquires the old lock; a `kuzo credentials set` from 0.1.0 acquires the new lock. They run concurrently with no protection.

**Fix:** During the upgrade transition, the new CLI (0.1.0) MUST acquire BOTH locks:
1. `~/.kuzo/.lock` (canonical, new).
2. `~/.kuzo/plugins/.lock` (legacy, for cross-version safety).

Order: canonical first, legacy second. Release in reverse. If the legacy lock acquire fails (held by 0.0.2 process), release canonical and surface `E_LOCK_CROSS_VERSION` with "another kuzo process is running; wait and retry."

After three releases (or six months from 0.1.0), drop the legacy-lock acquire. Document in §B.6.1 known gotchas.

**Status:** ACCEPT.

---

### R28 [ADVISORY] `ensurePluginsRoot()` must not run for credentials-only operations

**Source:** ARCH B5 (related).
**Spec section:** §B.6 implementation note.

**Problem:** `acquireLock()` today calls `ensurePluginsRoot()` to create `~/.kuzo/plugins/` before locking. If credentials-only operations move to `~/.kuzo/.lock`, the plugins dir shouldn't be auto-created when the user is only setting credentials.

**Fix:** Split helpers:
- `ensureKuzoHome()` — creates `~/.kuzo/` only.
- `ensurePluginsRoot()` — calls `ensureKuzoHome()` then creates `~/.kuzo/plugins/`.
- Credentials commands call `ensureKuzoHome()` only.
- Plugin commands call `ensurePluginsRoot()`.

**Status:** ACCEPT.

---

### R29 [ADVISORY] Update `extractCredentialCapabilities` callsite at loader.ts:332

**Source:** ARCH A3.
**Spec section:** §C.6.

**Problem:** Spec §C.6 says "the legacy `extractV2Config()` helper in loader.ts can be deleted." True. But `extractCredentialCapabilities` at `loader.ts:199-203` is ALSO called at `loader.ts:332` to populate the child-side broker's capabilities array via `PluginProcess` constructor. That helper stays.

**Fix:** §C.6 explicitly distinguishes: "`extractV2Config()` is deleted (replaced by `credentialSource.extractForPlugin()`). `extractCredentialCapabilities()` STAYS — it's still needed at loader.ts:332 to ship capability declarations to the child for broker reconstruction."

**Status:** ACCEPT.

---

### R30 [ADVISORY] Verify CLI→core module resolution in installed mode (npm install -g)

**Source:** ARCH A6.
**Spec section:** §D.1 + §D.5.

**Problem:** `kuzo serve` does `await import("@kuzo-mcp/core/server")`. In `npm install -g @kuzo-mcp/cli` mode, the CLI's `node_modules/@kuzo-mcp/core` is resolved. If the bundled core is older than the CLI expects, `runServer` may not exist.

**Fix:**
1. Add `@kuzo-mcp/core` as a strict version pin (not range) in `packages/cli/package.json` dependencies. Since changesets's `linked: [["@kuzo-mcp/types","@kuzo-mcp/core"]]` doesn't extend to cli, manually keep cli's core dep at-or-near the just-released core version (`workspace:^` in source becomes `^X.Y.Z` at publish).
2. Add §F.1 acceptance: "After `npm install -g @kuzo-mcp/cli@<v>`, `kuzo serve --version` prints both cli and resolved-core versions; CI smoke test verifies they match the published manifest."

**Status:** ACCEPT.

---

### R31 [ADVISORY] `.env` file scrub policy — what happens to creds in `.env` post-migration

**Source:** ARCH A7.
**Spec section:** §C.7 + §B.4.

**Problem:** Spec §C.7 says `loadDotenv()` stays for non-credential config. But after migrate, `.env` itself MAY still hold credentials the user wrote post-migrate, OR if migrate failed for `.env` rewrite. `loadDotenv()` would load them at boot, and they'd flow through `collectEnvOverrides` → scrub. Mostly OK, but the underlying `.env` file is still a plaintext leak surface (FS-readable mode 644).

**Fix:**
1. After migrate, `.env` redaction is part of the rewrite (already in spec).
2. At boot, after `loadDotenv` populates env, scan for any known-credential-names that came from `.env` (vs. from the shell env). Emit a once-per-boot warning to stderr: `[kuzo] WARNING: detected credential <NAME> in .env file at <path>. Run 'kuzo credentials migrate' to move it to encrypted storage.`
3. Don't refuse to boot — the user might have a reason (CI checkout with secrets via `.env.test` etc.). Just warn.

**Status:** ACCEPT.

---

### R32 [NIT] Boot-sequence smoke test acceptance criterion is too vague

**Source:** ARCH A8.
**Spec section:** §F.1 Part C acceptance.

**Problem:** "Boot sequence smoke test asserts ... (b) scrub happens before any plugin's `initialize()` is called" is trivially true under lazy-spawn (parent never calls `initialize()`).

**Fix:** Rewrite acceptance criterion as: "Smoke test: after `runServer()` boot completes, `process.env.GITHUB_TOKEN` and `process.env.KUZO_PASSPHRASE` are both `undefined` (or never-defined). When a plugin's child process is then spawned via first tool call, `process.env.GITHUB_TOKEN` in the child is ALSO `undefined`. Credentials reach the child only via the IPC `env` payload."

**Status:** ACCEPT.

---

## Theme 7 — User journey + CLI surface

### R33 [BLOCKING] Add `kuzo credentials test <name>` subcommand for validity verification

**Source:** UX B6; ARCH A9 (converged).
**Spec section:** §B.1 + §B.8.

**Problem:** Dropping `get` was correct, but the user has no way to verify a stored credential actually works. Symptom: tool call returns 401, user doesn't know if it's stale token, plugin bug, or migrate corruption.

**Fix:** New subcommand `kuzo credentials test <name>`:
1. Looks up the plugin owning the credential (via the same union-of-CredentialCapability scan migrate uses).
2. For first-party plugins (`github`, `jira`): calls a known cheap endpoint (`GET /user` for github, `/myself` for jira) via the plugin's client factory.
3. For third-party plugins: relies on a new optional `KuzoPluginV2.testCredential?(name: string, broker: CredentialBroker): Promise<{ok: boolean; message?: string}>` hook. If absent, prints "no validity test available for plugin <name>; presence verified but value not API-validated."
4. Output: `✓ GITHUB_TOKEN — authenticated as seantokuzo` or `✗ GITHUB_TOKEN — HTTP 401 unauthorized`.
5. Exit codes: 0 = valid, 78 (`E_CRED_INVALID`) = API rejected, 79 (`E_TEST_UNAVAILABLE`) = no test hook.
6. Audit-emits `credential.tested` with outcome (no value).

Document in §B.1 alongside `set`, `list`, etc.

**Status:** ACCEPT.

---

### R34 [BLOCKING] Wire rotation cache invalidation (file watch in `kuzo serve`)

**Source:** UX B7.
**Spec section:** §C.3 + new §C.11.

**Problem:** `kuzo credentials rotate GITHUB_TOKEN` writes to disk. The running `kuzo serve` parent's `EncryptedCredentialStore.cache` still holds the old value. The plugin child also holds the old value. Tool calls keep using the stale token.

**Fix:**
1. Parent's `runServer()` starts an `fs.watch` on `credentialsFilePath()` after first store unlock.
2. On change event: parent calls `credentialStore.reload()`, re-decrypts the new blob.
3. For each running `PluginProcess`, the parent recomputes the per-plugin Map and sends a new IPC notification `{type: "credential.refresh", config: {...}}`.
4. The child's plugin-host handler receives, atomically replaces the broker's scoped Map. The next `getClient` call uses the new value (existing clients via `clientCache` may still hold stale auth headers — for v1, restart-recommended for ALL rotation; the cache-replacement is a *partial* mitigation).
5. Document tradeoff in §F.4: "Rotation propagates to running plugins via file-watch + IPC. However, plugins that have already constructed an API client (e.g., Octokit) may continue to use the prior token until the client is reconstructed. **Restarting Claude Code is the only fully-reliable way to ensure rotation takes effect.**"

**Pushback considered:** UX suggested option 2 ("document restart" only). I'm choosing option 1 + the doc'd caveat — the auto-reload is cheap and meaningfully better for the common case where the running plugin hasn't constructed a long-lived client yet.

**Status:** ACCEPT.

---

### R35 [BLOCKING] Upgrade-detection startup banner

**Source:** UX B2.
**Spec section:** §D.3 + §C.7 (related to R31).

**Problem:** 0.0.2→0.1.0 upgraders get functional continuity but no nudge to migrate. They keep plaintext tokens in settings.json indefinitely unless they read release notes.

**Fix:** At `runServer()` ready-time, emit a one-line stderr banner when:
- `collectEnvOverrides()` returned ≥1 known credential name FROM `process.env` (not from store), AND
- The store has zero stored credentials.

Banner: `[kuzo] Detected unencrypted credentials in your environment. Run 'kuzo credentials migrate' to move them to the encrypted store.`

Emit once per boot. Suppressible via `KUZO_NO_MIGRATE_NUDGE=1` for users who intentionally use env-override-only (CI).

**Status:** ACCEPT.

---

### R36 [BLOCKING] Consolidated exit-codes table

**Source:** UX B9.
**Spec section:** New §B.10.

**Problem:** Exit codes are scattered: 60, 65, 66, 70, 71, 30, and new ones from R9 (72/73), R18 (74/75), R19 (76), R20 (77), R33 (78/79). Implementer can't write the central error-mapper without a table.

**Fix:** New §B.10 with a full table:

| Code | Symbol | Source | Meaning |
|---|---|---|---|
| 0 | OK | any | Success |
| 30 | `E_LOCK_CONTENTION` | shared | Another kuzo process holds the lock |
| 60 | `E_READBACK_FAIL` | migrate | Read-back-verify did not match the stored value |
| 65 | `E_NO_INPUT_MODE` | set/rotate | stdin not TTY and `--stdin` not passed |
| 66 | `E_EMPTY_VALUE` / `E_INVALID_VALUE` | set/rotate | Value rejected (empty / NUL / newline) |
| 70 | (generic) | serve | Server startup failure (uncaught throw from `runServer`) |
| 71 | `E_NO_KEY_PROVIDER` | serve/set | `KUZO_DISABLE_KEYCHAIN=1` without `KUZO_PASSPHRASE` |
| 72 | `E_KEY_LOST` | set/serve | `credentials.enc` exists but keychain entry missing |
| 73 | `E_FILE_CORRUPTED` | any | GCM verification failed (bad key OR tampered file) |
| 74 | `E_SYMLINK_REFUSE` | migrate | Source file is a symlink |
| 75 | `E_NOT_REGULAR_FILE` | migrate | Source path is not a regular file |
| 76 | `E_SOURCE_MUTATED` | migrate | Source file changed during migration |
| 77 | `E_CONFLICT` | migrate | Source value differs from stored value |
| 78 | `E_CRED_INVALID` | test | API rejected the credential |
| 79 | `E_TEST_UNAVAILABLE` | test | Plugin doesn't expose `testCredential` |

Add §F.1 acceptance: "Every error code in §B.10 has a corresponding `exitCodeForXXXError(err)` mapper in `packages/cli/src/commands/credentials/errors.ts`, and a unit test enumerates them."

**Status:** ACCEPT.

---

### R37 [BLOCKING] Update CLI `preAction` hook for new subcommands

**Source:** UX A2.
**Spec section:** New §B.11 + §D.4.

**Problem:** Existing CLI's `preAction` hook in `packages/cli/src/index.ts:60-68` refuses to run anything not in `noConfigCommands` if `isConfigured()` (= `process.env.GITHUB_TOKEN` exists) is false. New subcommands `kuzo credentials *` and `kuzo serve` are NOT in `noConfigCommands` — so a fresh install will refuse to run them.

**Fix:** Add `"credentials"` and `"serve"` to `noConfigCommands`. Also: long-term, replace `isConfigured()` with `CredentialSource.has("GITHUB_TOKEN")` so post-2.6 users who use only `kuzo credentials set` (no env vars) don't get bothered. Long-term replacement is out of scope for round 3 — just patch `noConfigCommands` for now, file a §F.2 open question to revisit.

**Status:** ACCEPT.

---

### R38 [BLOCKING] Parity-test setup must use `KUZO_PASSPHRASE` + `KUZO_HOME` to skip keychain

**Source:** UX B4.
**Spec section:** §E.5 + new acceptance in §F.1.

**Problem:** 2.5e parity test (`scripts/test-install-parity.mjs`) boots `runServer()`. After 2.6, the boot path constructs a `KeychainKeyProvider` and (per R5) defers actual key access — fine. But if any plugin loaded in the parity test declares a credential capability, the first `extractForPlugin` triggers `acquireKey()` → prompts on macOS local dev, throws in CI.

**Fix:** Update `scripts/test-install-parity.mjs` to set `KUZO_PASSPHRASE=parity-test-not-secret` and `KUZO_HOME=$WORK/kuzo-home` before spawning the server. The test directory's `credentials.enc` is created fresh per run with the test passphrase. Document in §E.5 + §F.1 acceptance.

**Status:** ACCEPT.

---

### R39 [BLOCKING] CI guidance section

**Source:** UX B5.
**Spec section:** New §F.5 "CI / headless deployment patterns."

**Problem:** No documented CI pattern. Implementer reads §A.5 `chooseKeyProvider()` and may assume "always tries keychain."

**Fix:** New §F.5 with three documented patterns:

1. **Pure env-override (recommended for ephemeral CI):**
   ```yaml
   env:
     KUZO_DISABLE_KEYCHAIN: "1"
     # No KUZO_PASSPHRASE — uses NullKeyProvider, no store
     GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
     JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}
     # ... etc per plugin
   ```
   Plugins never touch `credentials.enc`. Zero keychain interaction. Per-credential injection.

2. **Passphrase + stored credentials (for long-lived headless boxes):**
   ```yaml
   env:
     KUZO_PASSPHRASE: ${{ secrets.KUZO_PASSPHRASE }}
     KUZO_HOME: /var/lib/kuzo
   ```
   Credentials.enc lives at `/var/lib/kuzo/credentials.enc`; passphrase derives the key. Initial provisioning: `KUZO_PASSPHRASE=... kuzo credentials set GITHUB_TOKEN --stdin < secret_token` on the box.

3. **`op run` injection (for 1Password users):**
   ```bash
   op run -- kuzo serve
   ```
   `op` injects env vars at process spawn. Flows through `collectEnvOverrides` automatically. Document the `.env.op` template pattern.

Add §F.1 acceptance: "Smoke test CI workflow runs pattern 1 (`KUZO_DISABLE_KEYCHAIN=1` + env-injected GITHUB_TOKEN) end-to-end via the parity test fixture, asserting `get_repo_info` succeeds without any keychain interaction."

**Status:** ACCEPT.

---

### R40 [ADVISORY] First-install onboarding — link the install command to settings.json wiring

**Source:** UX B1.
**Spec section:** §D.2 + §B.3 inline-install success message.

**Problem:** User runs `kuzo plugins install github`, gets inline credential prompt, types token, sees "Stored." — but is never told to wire `~/.claude/settings.json`. They restart Claude Code, nothing happens.

**Fix:**
1. After EVERY successful `kuzo plugins install`, the install command's success message prints (once per install):
   ```
   Plugin installed.

   ⚠ To use this plugin with Claude Code, add the kuzo MCP server to your settings:
     1. Open ~/.claude/settings.json
     2. In mcpServers, add: { "kuzo": { "command": "kuzo", "args": ["serve"], "env": {} } }
     3. Restart Claude Code

   Already wired? You can ignore this. To suppress this hint: kuzo plugins install <name> --no-onboarding-hint
   ```
2. Detect "already wired" by checking if `~/.claude/settings.json` exists AND contains `"kuzo"` in `mcpServers`. If so, skip the hint.
3. After 2.6 ships, `kuzo plugins install` for the second-and-later plugins skips the hint automatically.

Document in §D.2.

**Status:** ACCEPT.

---

## Theme 8 — Documentation

### R41 [ADVISORY] README content outline

**Source:** UX A9.
**Spec section:** §F.3 cutover step 9 expansion.

**Problem:** "Update README.md" is listed as a cutover step but README content is never sketched. Implementer reinvents.

**Fix:** §F.3 step 9 expands to an outline:

- **README — Phase 2.6 additions (target ~120 lines):**
  - "Getting started" — replace the existing single command with: install CLI → plugins install → inline credential set → settings.json wiring → restart Claude Code. Mockup each step.
  - "Credentials" section:
    - macOS user (default keychain mode) — expected prompt on first set, "Always Allow" tip.
    - Linux desktop user (Secret Service) — same flow.
    - Linux headless / CI — `KUZO_PASSPHRASE` env pattern (link to §F.5).
    - `op run` / 1Password — link to §F.5 pattern 3.
    - Volta/nvm/asdf users — expect a fresh prompt per Node upgrade; "Always Allow" sticks per Node binary.
  - "Upgrading from 0.0.2" section — explicit `kuzo credentials migrate` instructions + what to expect post-migrate.
  - "Backups" section — `credentials.enc` is encrypted with the keychain master key; Time Machine restore safe IF keychain is also restored; if migrating Macs, run `kuzo credentials wipe + migrate` on the new machine.
  - "Recovery" — what to do if keychain is lost (kuzo credentials wipe → re-provision).

**Status:** ACCEPT.

---

### R42 [ADVISORY] `--help` mockups for `migrate` and `status` (not the trivial commands)

**Source:** UX A1.
**Spec section:** §B.1.

**Problem:** Commander auto-generates `--help`. For `kuzo credentials set --help` this is fine — flags are obvious. For `migrate` and `status`, the interactions (source filtering, partial-failure paths, JSON output) deserve documented example output so the implementer knows what to put in `.addHelpText("after", ...)`.

**Fix:** Add two `--help` mockups in §B.1:
- `kuzo credentials migrate --help` — shows all flags + an "Examples" block.
- `kuzo credentials status --help` — shows JSON schema in a footnote.

**Pushback considered:** UX suggested mocking all commands' help. For `set`/`list`/`delete`/`rotate` the Commander-default output is fine; mocking them adds drift risk. Limit to the two complex commands.

**Status:** PARTIAL — accept for migrate + status only.

---

### R43 [NIT] Add Phase 2.6 reference + non-goal "shell completion"

**Source:** UX A8.
**Spec section:** §0 non-goals.

**Problem:** Shell completion (bash/zsh/fish) isn't mentioned anywhere. Implementer may assume it's expected.

**Fix:** Add to §0 non-goals: "**Shell completion** (`bash`/`zsh`/`fish`) — deferred to a future phase. Not part of 2.6."

**Status:** ACCEPT.

---

## Theme 9 — Nits (single consolidated cleanup)

### R44 [NIT] Final consistency sweep

**Source:** All three reviewers (multiple NIT findings).
**Spec section:** Various.

Apply in a single editing pass:
- §0 Locked Decisions Q1 already fixed to remove `^` (done in round 2 edit). Verify no other `^1.3.0` references remain.
- `✓` vs `✔`: pick `✓` (matches existing install.ts). Replace `✔` globally in spec mockups.
- §A.4 `CredentialStore.has(key)` comment "without decrypting" — clarify: "without re-decrypting; requires at least one prior `get()` or `reload()` to have populated the cache."
- §A.6 `extractForPlugin` filtering — clarify the optional-vs-required split mechanic.
- §B.5 `list` table heading `LAST UPDATED` vs JSON `lastUpdated` — add a "table heading is human-readable; JSON keys are camelCase" note.
- §B.1 `--type pat` — drop the flag for v1 entirely; re-add when GitHub App support lands per Q9. (Locked decisions table updates accordingly.)
- §B.3 mockup uses `✔` in inline-install — switch to `✓`.
- §F.4 "no keychain is worse" framing — reconcile with the `cli/cli#10108` "fail loud" lesson cited elsewhere. Rewrite as: "The alternative of silently accepting plain-env fallback is worse — `cli/cli#10108` documented this as a UX trap. We fail loud instead."
- §A.2 "AES-GCM offers nothing ChaCha doesn't on hardware-accelerated platforms" — soften: "AES-256-GCM is the default for hardware-accelerated platforms. On platforms without AES-NI (legacy ARM), AES-GCM is software-implemented and ~3× slower than ChaCha20-Poly1305. The blob is small (<1 KB typical) — the difference is sub-millisecond. AES-GCM stays the default."
- §C.5 audit event `credential.store_locked` details: change `{}` to `{priorCount: number}` (matches the honest version of zeroing per R13).
- §D.1 `serve` exit code 70 — collision with sysexits.h `EX_SOFTWARE`. Document the overlap explicitly or move to 80+. Move to 80 (`E_SERVER_BOOT_FAILED`). Update R36 table.
- §F.4 "Master key loss" — add affordance: "Recommend periodic `kuzo credentials list --json > ~/.kuzo-creds-backup.json` to know what to re-provision."

**Status:** ACCEPT.

---

## Structural decisions — CONFIRMED 2026-05-10

All six STRUCTURAL items confirmed with the recommended directions. Fresh session proceeds without re-asking.

| # | Item | Direction | Confirmed |
|---|---|---|---|
| R1 | Parent-eager decrypt model (one keychain prompt at boot if any plugin needs stored creds, zero if env-override-only) | Model A | ✓ 2026-05-10 |
| R7 | Scrub `KUZO_PASSPHRASE` unconditionally; no escape hatch | No escape hatch | ✓ 2026-05-10 |
| R12 | Generation counter in keychain entry to defeat backup-rollback (trade: legitimate Time Machine restore requires `wipe + re-import`) | Generation counter in | ✓ 2026-05-10 |
| R14 | Tiered dep policy (exact pin Tier 1 only, caret-range Tier 2 with dependabot review) | Tiered | ✓ 2026-05-10 |
| R16 | Route plugin-host audit emissions through IPC (modify plugin-host.ts + plugin-process.ts + audit.ts) | IPC route in | ✓ 2026-05-10 |
| R24 | Move `registerClientFactory` from `@kuzo-mcp/core/credentials` to `PluginContext.credentials.registerClientFactory` | On PluginContext | ✓ 2026-05-10 |

---

## Items I considered pushing back on harder but didn't

For transparency on what I almost rejected:

1. **SEC A2 (`flock`-based locking)** — Reviewer suggested replacing `O_EXCL` + PID staleness with `flock`. Cross-platform `flock` has Windows portability concerns (`fs-ext` is unmaintained; libuv flock support is partial). PID + staleness is good-enough for our single-user model; the lock-held-during-multi-step-rewrite risk is real but bounded to seconds. **Decision: keep current pattern. Not in remediation list. Reviewer was correct in principle but the pragmatics push back.**

2. **SEC A1 (`kuzo serve` no-lock vs. shared read-lock)** — Reviewer noted that serve doesn't take the lock so writers can change disk while server holds stale cache. R34 (file-watch + IPC refresh) solves the cache-staleness in the common case. **Decision: file-watch beats read-lock — read-lock would block CLI writers while serve runs, which is daily-broken UX.**

3. **UX A1 (full `--help` mockups for every subcommand)** — Reviewer suggested mocking all `kuzo credentials *` subcommand help output. Commander auto-generates these well for simple commands. **Decision: PARTIAL (R42) — mockup only `migrate` and `status` where flag interactions are non-obvious.**

4. **UX B8 (`kuzo serve` lock semantics)** — Reviewer asked spec to specify whether serve takes the lock. R34 (no lock, fs.watch instead) is the answer. **Decision: include in R34 as the resolution.**

5. **ARCH A4 (migrate dry-run keychain prompt)** — Reviewer flagged the prompt as UX-mutation. **Decision: PARTIAL (R21) — skip the equality check in dry-run; print "would import" for any source key, conservative.** Doesn't restructure decrypt path.

---

**Document locked 2026-05-10.** Hand off to fresh session for round-3 execution. After execution, this document can be deleted — its purpose is bounded to the round-3 revision cycle.
