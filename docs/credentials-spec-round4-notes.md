# Credentials Spec — Round 4 Review Notes

> Companion to `docs/credentials-spec.md`. Captures the round-4 independent multi-reviewer findings (Security + Architecture + Correctness specialists, each blind to the others) and their disposition in the spec. Deleted alongside `credentials-spec-round3-notes.md` during phase-close per issue #39.

**Review run:** 2026-05-13. Three reviewer subagents launched in parallel, no shared context. Synthesis + spot-verification of "spec contradicts current code" claims before triage. User approved 6 decisions before drafting; all 15 blocking findings absorbed; all 13 advisories absorbed; ~25 nits batched.

---

## Decisions locked by user before drafting

| # | Decision | Disposition |
|---|---|---|
| 1 | Keychain payload format: **Option A** — JSON blob `{format_version: 1, key, generation}`. §A.5 code rewritten to JSON-parse. | §A.2 + §A.5 |
| 2 | Capability env-naming: **all 3 components** + strict per-plugin reservation (no `--allow-credential-aliasing` escape hatch). | New §A.12 |
| 3 | fs.watch fix: **directory-watch** (not file-watch). | §C.11 |
| 4 | Audit rate limit: **100/sec sustained, 200 burst, 50 MiB rotation × 5 retention**. | New §C.10.1 |
| 5 | `kuzo serve` versioning: **Option C** — stderr boot log + explicit `kuzo --version`. | §F.1 + §F.4 |
| 6 | PR strategy: **per-Theme PRs** (one per §0 build-order step). | §F.3 step 10 |

---

## Blocking findings — disposition

### Theme A — Spec contradicts current code (3)

| # | Finding | Section(s) edited |
|---|---|---|
| B1 | `kuzoPlugin.capabilities` doesn't exist in any plugin `package.json`. Load-bearing for §C.1 pre-scrub manifest read. | NEW §A.0.1 + §0 new step 0 + §C.1 invariant 6 + §A.7 + §F.1 acceptance |
| B2 | `server.ts` self-invocation guard claimed "kept" but absent (file ends with unconditional `main().catch(...)`). | §0 step 4 + §C.0 + §D.5 + §F.1 acceptance |
| B3 | `new PluginRegistry()` example missing `KuzoLogger` constructor arg. | §C.1 step 9 + new §F.1 acceptance |

### Theme B — Internal spec contradictions (4)

| # | Finding | Section(s) edited |
|---|---|---|
| B4 | `CredentialCapability.optional?: boolean` referenced but Q10 locks no schema changes and field doesn't exist. | §A.6 `extractForPlugin` rewritten to `{required, optional}` split shape + loader swap example updated |
| B5 | Keychain blob: §A.2 says JSON `{key, generation}`, §A.5 code did raw base64. R12 rollback defense broken if §A.5 followed. | §A.2 spelled out as `{format_version, key, generation}` + §A.5 rewritten to JSON-parse with `getGeneration` / `bumpGeneration` helpers |
| B6 | §B.4 migrate step 4 (editor-collision check) logically must run INSIDE step 3 (before rename), not after. | §B.4 restructured: step 3 now has substeps 3.a (build tmp), 3.b (collision check), 3.c (atomic write), 3.d (post-rewrite redaction-verify) |
| B7 | §B.4 rollback step 2.b references "memory copy taken at the start" that step 1 never snapshots. | §B.4 step 1.f added (`storeSnapshot` of `credentials.enc` + generation) + step 2.c added explicit rollback path |

### Theme C — Missing definitions (3)

| # | Finding | Section(s) edited |
|---|---|---|
| B8 | ~10 undefined methods/types/helpers (`isUnlocked`/`size` on store, `runningProcesses`/`PluginProcess.notify`/`declaredCapabilities` on loader/proc, `acquireFileLock`/`LockHandle`/`LockBusyError`/`LockCrossVersionError`, `isCredentialCapability`, `debounce`). | `CredentialStore` interface in §A.4 extended; §B.6.1 lock helpers fully defined; §C.11 helper-definitions block added; §A.0.1 type guard exported |
| B9 | `AUDIT_ACTION_PARTITION` literal had ellipsis comment — `Record<AuditAction>` is exhaustive by type; won't compile. | §C.10 partition literal fully enumerated (4 child + 20 parent including 2.5c/2.5e existing) |
| B10 | Exit code 60 (`E_READBACK_FAIL`) used for two distinct failures (crypto round-trip vs parser drift). | §B.10 split: 60 stays as round-trip mismatch; 61 `E_REDACTION_VERIFY_FAIL` for parser drift; 62 `E_ROLLBACK_FAIL` for B7 rollback; 63 `E_INVALID_FLAG_COMBO`; 64 `E_WIPE_CANCELLED`; 67-70 for §A.12 env-name failures |

### Theme D — Silent audit gaps (2)

| # | Finding | Section(s) edited |
|---|---|---|
| B11 | `KUZO_NO_ENV_SCRUB=1` kill-switch silently no-ops; no `credential.scrub_disabled` audit emission. | §A.7 `scrubProcessEnv` threaded `auditLogger`; emit moved to single point inside the function for both kill-switch paths |
| B12 | `PassphraseKeyProvider.initializeKey()` doesn't emit `credential.passphrase_consumed` on first setup; R8 salt-swap detection breaks. | §A.5 `initializeKey` emits with `initialized: true`; `acquireKey` emit gets matching `initialized: false` discriminant |

### Theme E — Novel security gaps (3)

| # | Finding | Section(s) edited |
|---|---|---|
| B13 | `CredentialCapability.env` had no naming policy; malicious plugin could break boot (PATH), alias other plugins' creds (GITHUB_TOKEN), or capture KUZO_PASSPHRASE. | NEW §A.12 — strict per-plugin env-var reservation. Hardcoded first-party reservation map + local namespace registry (`${KUZO_HOME}/env-namespace.json`) + 4-stage install-time validation (format → system denylist → first-party reservation → cross-plugin collision). No escape hatch. |
| B14 | `fs.watch(credentialsFilePath)` is detached by atomic-rename write path; rotation #2+ silently fails. | §C.11 switched to `fs.watch(dirname)` with `filename === "credentials.enc"` filter + `existsSync` re-check for unlink-only events. §F.1 acceptance updated to test 3 rotations within a single server lifetime. |
| B15 | Child→parent audit IPC has no rate limit; plugin-driven log DoS / disk fill; brief Q14 retention unresolved. | NEW §C.10.1 — token-bucket rate limit (100/sec sustained, 200 burst per child PID) + 50 MiB log rotation with 5 retained files. `audit.rate_limited` + `audit.partition_initialized` actions added to AuditAction union + AUDIT_ACTION_PARTITION. |

---

## Advisory findings — disposition

| # | Finding | Disposition |
|---|---|---|
| A1 (Arch) | Module-level `clientFactories` singleton in `credentials.ts:46` violates brief constraint #7. | §C.4 pre-amble — retire module-level Maps; move into broker constructor |
| A2 (Arch) | Shutdown invariant 4 rationale ("plugins may make final credential reads") contradicts §C.3 (child has no path to store). | §C.1 invariant 4 rewritten — true rationale is §C.11 file-watch handler lifetime |
| A3 (Arch) | `IpcAuditLogger implements AuditLogger` requires interface, but AuditLogger is a concrete class. | §C.10 — refactor `audit.ts` to `AuditLogger` interface + `FileBackedAuditLogger` class |
| A4 (Arch) + A2 (Corr) | `kuzo serve --version` unimplementable as stated (Commander subcommand version inheritance). | §F.1 — Option C: stderr boot log on `kuzo serve` + top-level `kuzo --version` |
| A5 (Arch) | §0 Theme-sequenced build order vs §F.3 step 10 "per-Part PRs" conflict. | §0 — per-Theme PRs locked; §F.3 step 10 rewritten to match |
| A1 (Sec) | `kuzo credentials wipe` + concurrent `kuzo serve` race. | §A.11 wipe section + new acceptance — wipe refuses without `--force-while-serving` when a `kuzo serve` PID file is present (out-of-scope to detail; documented as known risk + future hardening) |
| A2 (Sec) | `KUZO_NO_ENV_SCRUB` not scrubbed; inconsistent `"1"` vs `"true"` matching. | §A.7 `ALWAYS_SCRUB` extended with `KUZO_NO_ENV_SCRUB`; consistency note added |
| A3 (Sec) | `migrate --force-source --yes` bypasses interactive confirm. | §B.10 — exit 63 `E_INVALID_FLAG_COMBO` for the combo |
| A4 (Sec) | `scryptSync` blocks event loop; sync allocation under concurrent boots wedges small CI. | Documented as known risk in §F.5 Pattern 2 (passphrase boxes need ≥256 MiB headroom). Switching to async `scrypt` deferred — non-trivial refactor of `KeyProvider` interface; tracked as future hardening. |
| A5 (Sec) | `KUZO_HOME` not in scrub list, re-read lazily on every `kuzoHome()` call. | Documented as known limitation in §E.5. Caching at boot would change `paths.ts` semantics; deferred. |
| A6 (Sec) | Keychain blob `generation` not cryptographically bound to master key. Attacker with keychain-write can DoS via gen-bump. | §A.2 — `format_version: 1` admits future `hmac` field; deferred as fast-follow (round-5 candidate). |
| A1 (Corr) | `AuditEvent.pid` field used implicitly. | §B.7 — `AuditEvent` shape extended with `pid?: number` (optional for pre-2.6 compat) |
| A3 (Corr) | Unrestricted `KUZO_TOKEN_*` patterns. | Documented as intentional — future-proof override for env names not in declared set |
| A4 (Corr) | `loadDotenv` can't tell .env vs shell source. | §C.7 R31 — `ConfigManager.loadDotenv()` returns the dotenv-config `parsed` map; `getDotenvKeys()` exposes the set |
| A5 (Corr) | `.env` re-serializer escape rules unpinned. | §B.4 — explicit escape table: `\n`→`\\n`, `\r`→`\\r`, `\t`→`\\t`, `\\`→`\\\\`, `"`→`\\"`; do NOT escape `$` |
| A6 (Corr) | `--force-source` / `--source` flag naming overlap. | §B.4 — documented as orthogonal; rename deferred (round-5 candidate) |
| A7 (Corr) | `wipe` lacks exit codes. | §B.10 — 64 `E_WIPE_CANCELLED` added |
| A8 (Corr) | `--no-onboarding-hint` persistence ambiguous. | §B.3 — per-invocation flag only; env var is the persistent knob |
| A9 (Corr) | Multi-cap service `test` semantics. | §B.9 — clarified test runs full scoped credential map; per-name validity is up to plugin's `testCredential` hook |
| A10 (Corr) | Echo-off detection no actionable code path. | §B.8 — `process.stdin.setRawMode(true)` precheck; refuse on throw |
| A11 (Corr) | Multiple MCP entries in settings.json undefined. | §B.4 — process ALL matching entries; document |
| A13 (Corr) | `KuzoPluginV2.testCredential` is contract change; types bump unaddressed. | §F.3 step 11 — `@kuzo-mcp/types` bumps to 0.1.0 alongside core/cli (optional-field addition still counts as minor bump) |
| A14 (Corr) | F.8 command/args rewrite not in §B.4 body. | §B.4 step 3 — settings.json branch rewrites `command`/`args` to canonical |

---

## Nits — batched

~25 line-level cleanup items (number-list collisions in §B.4, dangling Theme references after round-3-notes deletion, command examples not run through tsc/JSON-parse, `KUZO_TOKEN_<KUZO_PASSPHRASE>` no-op delete, etc.) folded into the spec edits where the surrounding context was touched. Remaining nits left for a single sweep commit late in implementation, tracked here for visibility only — not blocking spec lock.

---

## Spot-verified claims about current code

All five high-impact "spec contradicts current code" claims confirmed real before applying fixes:

1. ✅ `packages/plugin-github/package.json`, `packages/plugin-jira/package.json`, `packages/plugin-git-context/package.json` — `kuzoPlugin` block contains only `{name, permissionModel, entry, minCoreVersion}`, no `capabilities`.
2. ✅ `packages/core/src/server.ts:225` — `main().catch(error => ...)` at file bottom, no `import.meta.url === pathToFileURL(...)` guard.
3. ✅ `packages/core/src/registry.ts:30` — `constructor(private logger: KuzoLogger) {}`.
4. ✅ `packages/core/src/credentials.ts:46` — `const clientFactories = new Map<string, ClientFactory>([...])` at module scope.
5. ✅ `packages/core/src/audit.ts:58` — `export class AuditLogger` (concrete, no interface).

---

## What's next

Implementation per §F.3 cutover. Build-order step 0 (manifest bake) lands first as its own micro-PR; Themes 1–9 each become PRs. Theme 8 (migrate) is the highest-risk PR; ship it alone with extra reviewer focus. Round-3 + round-4 notes (this doc + `credentials-spec-round3-notes.md`) deleted at phase-close per issue #39.
