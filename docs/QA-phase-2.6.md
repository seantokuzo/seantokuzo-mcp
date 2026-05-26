# Phase 2.6 — Credentials & Security QA

> **Run this at the end of Phase 2.6** (after Themes 8 + 9 land). This is the manual / real-life QA pass over the whole credential system — storage, the `kuzo credentials` CLI, install-time env-name reservation, the boot-time scrub, `kuzo serve`, and the Claude Code MCP integration.
>
> Status legend per item: `[ ]` not run · `[x]` pass · `[!]` fail (file an issue, link it).
> Theme legend per section: ✅ shipped (testable now) · ⏳ pending (lands in the named Theme).

---

## 0. How to use this doc

- Work top-to-bottom; each section is roughly independent.
- Most items are **CLI commands** — run them and check the **expected result** + **exit code** (`echo $?` after each).
- Use a **throwaway `KUZO_HOME`** so QA never touches your real `~/.kuzo`. Two credential backends to exercise:
  - **Keychain mode** (macOS default) — exercises the real OS keychain; expect one keychain prompt per Node binary lifetime.
  - **Passphrase mode** — `export KUZO_PASSPHRASE=...`; no keychain prompts, works headless. Good for scripted runs.
- After 2.6 ships, the binary is `kuzo` (from `@kuzo-mcp/cli`). Before the release, run from the repo via `node packages/cli/dist/index.js` after `pnpm build`.

### Clean-room setup

```bash
export KUZO_HOME="$(mktemp -d /tmp/kuzo-qa.XXXXXX)"   # isolated state root
# pick ONE backend per run:
export KUZO_PASSPHRASE="qa-passphrase"                # passphrase mode, OR
unset KUZO_PASSPHRASE                                  # keychain mode (macOS)
alias kuzo="node $(pwd)/packages/cli/dist/index.js"   # pre-release; drop once installed
# IMPORTANT: a project .env may set GITHUB_TOKEN/JIRA_* — those appear as
# "env overrides" in list/status. For store-path tests, run from a dir with no .env
# or use a credential name not present in .env (e.g. QA_TEST_TOKEN).
```

Teardown: `rm -rf "$KUZO_HOME"` (and in keychain mode, `kuzo credentials wipe --confirm` to drop the keychain master-key entry).

---

## 1. Storage & key providers (Themes 1–3) ✅

The encrypted store: AES-256-GCM blob at `$KUZO_HOME/credentials.enc`, master key from the OS keychain (or scrypt over `KUZO_PASSPHRASE`).

- [ ] **Encryption at rest** — `kuzo credentials set QA_TEST_TOKEN --stdin <<< "s3cret"`, then confirm `$KUZO_HOME/credentials.enc` is **binary / not greppable**: `grep -c s3cret "$KUZO_HOME/credentials.enc"` → `0`.
- [ ] **File mode** — `stat -f '%Sp' "$KUZO_HOME/credentials.enc"` → `-rw-------` (0600). `$KUZO_HOME` itself is `drwx------` (0700).
- [ ] **Round-trip** — after a `set`, `kuzo credentials list` shows the name; the value decrypts (it's served to plugins at runtime — verified in §6).
- [ ] **Keychain mode** — fresh `KUZO_HOME`, no `KUZO_PASSPHRASE`: first `set` creates a keychain entry (service `kuzo-mcp`, account `master-key`); macOS prompts once. `kuzo credentials status` → `Key provider: keychain`.
- [ ] **Passphrase mode** — `KUZO_PASSPHRASE` set: `set` writes `credentials.enc` + `credentials.generation`; no keychain prompt. `status` → `Key provider: passphrase`. A second process with the same passphrase round-trips (`list` works).
- [ ] **Wrong passphrase** — set in passphrase mode, then re-run `list` with a *different* `KUZO_PASSPHRASE` → **exit 73** (`E_FILE_CORRUPTED`, GCM verify fails). Does NOT corrupt or overwrite the file.
- [ ] **Null mode** — `export KUZO_DISABLE_KEYCHAIN=1` and unset `KUZO_PASSPHRASE`: `kuzo credentials set X` → refuses (no usable key provider, exit 71). Reads fall back to env overrides only.
- [ ] **`KUZO_HOME` override** — set `KUZO_HOME=/some/dir`; all state (`credentials.enc`, `audit.log`, `consent.json`, `plugins/`) lands under it, not `~/.kuzo`.
- [ ] **Generation / rollback resistance** — set a credential twice (gen bumps), copy `credentials.enc` aside, set again, restore the old copy → next read → **exit 73** (stale generation rejected, not silently accepted).

---

## 2. `kuzo credentials` CLI (Theme 7) ✅

### 2a. `set` / `rotate` + secret-input contract (§B.2)

- [ ] **Interactive set (TTY)** — `kuzo credentials set QA_TOKEN` → echo-off password prompt → `✓ Stored QA_TOKEN`.
- [ ] **`--stdin`** — `printf 'val' | kuzo credentials set QA_TOKEN --stdin` → stored; trailing newline trimmed.
- [ ] **Secret never on the command line** — `kuzo credentials set QA_TOKEN someValue` → `someValue` is rejected as an unexpected argument (there is no `<value>` positional). Confirm `history` / `ps aux` never show the secret.
- [ ] **Non-TTY without `--stdin`** — `echo x | kuzo credentials set QA_TOKEN < /dev/null` (no TTY, no `--stdin`) → refuses, **exit 65** (`E_NO_INPUT_MODE`) — no silent pipe read.
- [ ] **Empty value** — `printf '' | kuzo credentials set QA_TOKEN --stdin` → **exit 66** (`E_EMPTY_VALUE`).
- [ ] **NUL / embedded newline** — `printf 'a\nb' | kuzo credentials set QA_TOKEN --stdin` → **exit 66** (`E_INVALID_VALUE`).
- [ ] **Overwrite confirm** — set QA_TOKEN, then `set QA_TOKEN` again (TTY, no `-y`) → "already set. Overwrite?" prompt; `-y` skips it.
- [ ] **`rotate`** — `kuzo credentials rotate QA_TOKEN` behaves like `set` but the audit event is `credential.rotated` (verify in §5).

### 2b. `list` / `status`

- [ ] **`list`** — table of `NAME / BACKEND / LAST UPDATED`. `--json` → `{backend, storeFile, credentials:[{name,lastUpdated}]}`.
- [ ] **`status`** — shows key-provider backend, store file (path/size/mtime), per-plugin availability (✓ / missing), and active env overrides (value redacted). `--json` matches the §B.5 schema.
- [ ] **Empty store** — `list` on a fresh `KUZO_HOME` → "No credentials stored…".
- [ ] **Env-override visibility** — with `GITHUB_TOKEN` set in the shell, `status` marks github's creds as available via env override (not store).

### 2c. `test` (§B.9)

- [ ] **GitHub valid** — store a real `GITHUB_TOKEN`, `kuzo credentials test GITHUB_TOKEN` → `✓ … authenticated as <login>`, **exit 0**.
- [ ] **GitHub invalid** — store a garbage token → `✗ … HTTP 401 …`, **exit 78** (`E_CRED_INVALID`).
- [ ] **Jira valid** — store `JIRA_HOST`/`JIRA_EMAIL`/`JIRA_API_TOKEN` → `test JIRA_API_TOKEN` → authenticated, exit 0.
- [ ] **Jira missing pieces** — store only `JIRA_HOST` → `test JIRA_API_TOKEN` → "needs JIRA_EMAIL, JIRA_API_TOKEN", exit 79.
- [ ] **http JIRA refusal (security)** — set `JIRA_HOST=http://example.com` → `test` → refuses (no Basic-auth over cleartext), exit 79.
- [ ] **Network error** — disconnect / bad host → `✗ … DNS resolution failed`, generic non-zero exit.
- [ ] **No test available** — `test SOME_UNKNOWN_ENV` → exit 79 (`E_TEST_UNAVAILABLE`).

### 2d. `wipe` + §A.11 state machine

- [ ] **Refuse without `--confirm`** — `kuzo credentials wipe` → refuses, **exit 64**.
- [ ] **Cancel** — `kuzo credentials wipe --confirm`, type anything but `yes` → "cancelled", exit 64; store intact.
- [ ] **Confirm** — `wipe --confirm`, type `yes` → deletes the keychain entry + `credentials.enc` + `.generation`. `list` after → empty.
- [ ] **KEY_LOST recovery** — keychain mode: set a cred, then delete the keychain master-key entry out of band (or simulate) so the file exists but the key is gone → `kuzo credentials set X` → **exit 72** (`E_KEY_LOST`) with the recovery message. `wipe --confirm` then succeeds (works in KEY_LOST), and the next `set` re-initializes cleanly.
- [ ] **CORRUPTED recovery** — tamper with `credentials.enc` (flip a byte) → `set`/`list` → **exit 73** (`E_FILE_CORRUPTED`). `wipe --confirm` recovers.
- [ ] **No silent re-init (security)** — the above KEY_LOST/CORRUPTED states MUST NOT silently create a fresh key and orphan the old ciphertext; they must refuse until `wipe`.

---

## 3. Install-time env-name reservation (§A.12, Theme 7) ✅

These need a fixture plugin tarball (or `--trust-unsigned` against a local pack). The four checks fire in order, before any state mutation.

- [ ] **First-party reservation** — install a non-first-party package declaring `CredentialCapability env: "GITHUB_TOKEN"` → **exit 68** (`E_RESERVED_FIRST_PARTY_ENV`); nothing written to `~/.kuzo/plugins/`.
- [ ] **System denylist** — a plugin declaring `env: "PATH"` → **exit 67**; `env: "KUZO_PASSPHRASE"` → exit 67; `env: "LD_PRELOAD"` / `DYLD_INSERT_LIBRARIES` → exit 67.
- [ ] **Format reject** — `env: "lowercase"`, `"1DIGIT"`, `"HAS-DASH"`, a >64-char name → all **exit 70**.
- [ ] **Cross-plugin collision** — install `@a/foo` claiming `MYAPI_KEY`, then `@b/bar` claiming `MYAPI_KEY` → second → **exit 69** (`E_ENV_NAME_COLLISION`).
- [ ] **Uninstall releases the claim** — `uninstall @b/bar`, then re-install `@b/bar` with `MYAPI_KEY` → succeeds.
- [ ] **Registry file** — after a successful third-party install, `$KUZO_HOME/env-namespace.json` is mode 0600 and lists the plugin's envs; first-party plugins are pre-registered.
- [ ] **Build-time parity** — edit a first-party plugin to declare a cred env not in `FIRST_PARTY_ENV_RESERVATIONS` → `pnpm build` fails (reservation parity gate).
- [ ] **Audit** — each install/update/uninstall emits `credential.namespace_validated` with `{package, action, envs_added, envs_removed}`.

---

## 4. Inline prompt + onboarding hint (§B.3 / R40, Theme 7) ✅

- [ ] **Inline cred prompt** — `kuzo plugins install github` (interactive) → after install, offers to configure `GITHUB_TOKEN` if unset; sets it inline.
- [ ] **Already configured** — re-install with the cred already set (env or store) → skips the prompt.
- [ ] **`-y` skips prompt** — `install … -y` → prints "configure later via kuzo credentials set", no prompt.
- [ ] **Onboarding hint** — after install, prints the `~/.claude/settings.json` wiring nudge UNLESS already wired; `--no-onboarding-hint` (or `KUZO_NO_ONBOARDING_HINT=1`) suppresses it.

---

## 5. Audit log completeness (Themes 5–7) ✅

`$KUZO_HOME/audit.log` is JSONL, mode 0600. After exercising §2:

- [ ] **Write-side events present** — `credential.set`, `.rotated`, `.deleted`, `.wiped`, `.tested`, `.namespace_validated` appear with the right `credentialKey` / `outcome` and **never the secret value** (grep the log for your test secret → 0 hits).
- [ ] **Lifecycle events** — `credential.store_unlocked` / `.store_locked` on unlock/close; `credential.passphrase_consumed` (passphrase mode) with a `salt_fingerprint` (not the passphrase).
- [ ] **Rotation** — `audit.log` rotates at 50 MiB (5 retained); `kuzo audit` (if present) queries across rotated files.
- [ ] **Source stamping** — events carry `source: "parent"` for CLI/boot writes.

---

## 6. Boot, scrub & broker (Themes 4–6) ✅

Exercise via the install-parity harness or a real `runServer()` boot.

- [ ] **`process.env` scrub** — at boot, declared credential env names are deleted from `process.env` before plugins fork; a freshly-forked plugin child sees `GITHUB_TOKEN === undefined` (it gets the value via the broker, not the env).
- [ ] **Scrub is narrow** — only *declared* env names are scrubbed; `KUZO_TOKEN_PATH=evil` does NOT cause `PATH` to be deleted (the Theme-4 round-1 fix).
- [ ] **Broker serves clients** — github/jira plugins get a pre-authenticated client; raw access is audited (`credential.raw_access` / `.raw_denied`).
- [ ] **Shutdown scrub** — on shutdown the broker drops its credential maps and wipes the master-key cache.
- [ ] **Kill switch** — `KUZO_NO_ENV_SCRUB=1` emits `credential.scrub_disabled` and skips the declared-name scrub (but still scrubs `KUZO_PASSPHRASE`/`KUZO_NO_ENV_SCRUB`).

---

## 7. `kuzo credentials migrate` (§B.4) ⏳ Theme 8

> The highest-risk command. QA hard once it lands. Sources: `~/.claude/settings.json` env blocks + project `.env` files. Atomic redaction with read-back-verify.

- [ ] **`--dry-run`** — reports what would import, touches nothing.
- [ ] **`--source claude` / `env-file` / `both`** (default both) — scopes the scan correctly.
- [ ] **Happy path** — migrates known credential names into the store, then redacts them from the source file atomically.
- [ ] **Idempotent re-run** — running migrate twice is safe; the second run is a no-op for already-stored identical values.
- [ ] **Conflict** — stored value differs from source → **exit 77** (`E_CONFLICT`); `--force-source` overwrites (loud confirm); `--force-source --yes` together → **exit 63** (mutually exclusive).
- [ ] **Symlink source** → **exit 74**; non-regular file → **exit 75**; source mutated mid-migration → **exit 76**.
- [ ] **Read-back-verify fail** → **exit 60**; post-redact parser still finds the secret → **exit 61**; rollback fail → **exit 62**.
- [ ] **Filter** — only migrates names in the union of plugin `CredentialCapability.env`; ignores unrelated `.env` keys.
- [ ] **settings.json schema drift** — unparseable settings.json fails closed with a clear message.
- [ ] **Audit** — `credential.migrated` (with `source`) / `credential.migration_partial` on partial failure; never the value.

---

## 8. `kuzo serve` + rotation cache invalidation (§D / C.11) ⏳ Theme 9

- [ ] **`kuzo serve`** — boots the MCP server over stdio; `runServer()` lifecycle; usable from Claude Code.
- [ ] **First-run UX** — no credentials configured → helpful guidance (not a crash).
- [ ] **`--no-scrub`** — gated behind `KUZO_DEV=1` or an interactive confirm (NOT a vanilla flag); emits `credential.scrub_disabled` with a specific reason.
- [ ] **Rotation invalidation** — `kuzo credentials rotate X` while `serve` is running → the running plugin children pick up the new value (file-watch → IPC `credential.refresh`); emits `credential.refreshed_in_flight`.
- [ ] **Upgrade banner** — version-change detection banner at server-ready (R35).

---

## 9. Lock & concurrency (Theme 7) ✅

- [ ] **Shared lock** — `kuzo credentials set` and `kuzo plugins install` cannot run concurrently → second → **exit 30** (`E_LOCK_CONTENTION`).
- [ ] **Read-only no lock** — `list` / `status` / `test` / `plugins list` do NOT take the lock (run concurrently fine).
- [ ] **Stale lock reclaim** — kill a process mid-write (leaving a stale `.lock`) → next command reclaims it (dead-PID detection), doesn't hang.
- [ ] **Cross-version** (transition only) — a 0.0.x `plugins` op holding the legacy `~/.kuzo/plugins/.lock` blocks a 0.1.0 credential write with a clear "older version running" message (exit 30).

---

## 10. Exit-code table (§B.10) ✅

Spot-check the consolidated mapper — every code reachable and correct:

| Code | Trigger to verify |
|---|---|
| 30 | concurrent lock |
| 60–63, 74–77 | migrate (Theme 8) |
| 64 | `wipe` cancelled / no `--confirm` |
| 65 | non-TTY `set` without `--stdin` |
| 66 | empty / NUL / newline value |
| 67–70 | install env-name reservation (system/first-party/collision/format) |
| 71 | no key provider (`KUZO_DISABLE_KEYCHAIN` w/o passphrase) |
| 72 | KEY_LOST |
| 73 | CORRUPTED / wrong key |
| 78 | `test` credential rejected |
| 79 | `test` no validity test |
| 80 | `serve` boot failed (Theme 9) |

---

## 11. Real-life QA via Claude Code (the milestone) ⏳ after Theme 9 + release

The end goal: provision creds via the CLI (not hand-edited `.env`), then use kuzo as an MCP server in daily work.

- [ ] **Install** — `npm i -g @kuzo-mcp/cli@<release>` (or the published version); `kuzo --version` works.
- [ ] **Provision** — `kuzo credentials set GITHUB_TOKEN`, `kuzo credentials set JIRA_*` via the prompt; `kuzo credentials status` shows all green.
- [ ] **Wire Claude Code** — add `"kuzo": { "command": "kuzo", "args": ["serve"] }` to `~/.claude/settings.json` mcpServers; restart.
- [ ] **Exercise tools** — run real GitHub/Jira tool calls through Claude Code; confirm they authenticate via the broker (no tokens in env).
- [ ] **Rotate live** — rotate a token while serving; confirm tool calls pick up the new value without a restart.
- [ ] **Daily use** — use across normal work for a stretch; file issues for anything that surfaces. This is the bar for claiming `0.1.0`.

---

## 12. Threat-model verification (security phase) ✅/⏳

Cross-cutting security properties to explicitly confirm:

- [ ] **No secret in args/flags** (§B.2) — verified in §2a.
- [ ] **No secret in audit log** (§5) — grep the log for every test secret → 0 hits.
- [ ] **No secret in env post-scrub** (§6) — plugin child can't read declared envs from `process.env`.
- [ ] **First-party aliasing blocked** (§A.12 vector 2) — third-party can't claim `GITHUB_TOKEN` (§3).
- [ ] **Boot-breakage blocked** (§A.12 vector 1) — can't claim `PATH`/`NODE_OPTIONS`/`LD_*` (§3).
- [ ] **Passphrase capture blocked** (§A.12 vector 3) — can't claim `KUZO_PASSPHRASE` (§3).
- [ ] **Path traversal blocked** — `kuzo plugins install ..` (or a `../`-laden name) → rejected by the plugin-name guard.
- [ ] **Residual risk acknowledged** — third-party plugins declaring well-known third-party secret envs (AWS/OpenAI/…) are consent-gated, not blocked (issue #55; document in SECURITY.md).
- [ ] **Encryption at rest + 0600 perms** (§1) — confirmed.

---

_When every applicable box is checked and issues are filed for failures, Phase 2.6 is QA-clean and `0.1.0` is on the table._
