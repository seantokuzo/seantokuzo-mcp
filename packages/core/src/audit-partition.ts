/**
 * Exhaustive trust-partition of every `AuditAction` variant (spec §C.10).
 *
 * The `Record<AuditAction, ...>` literal MUST enumerate every union member
 * — TypeScript fails to compile if a variant is missing here. That makes
 * the partition load-bearing: adding a new `AuditAction` to `audit.ts`
 * without classifying it parent-only / child-permitted is a TYPE error,
 * not a runtime surprise.
 *
 * Acceptance test (spec §F.1): drop any `"child-permitted"` entry below
 * and `tsc --noEmit` MUST fail red with a "missing property" diagnostic.
 *
 * Future Themes that add new `AuditAction` variants MUST also add their
 * partition classification here in the same change.
 */

import type { AuditAction } from "./audit.js";

export const AUDIT_ACTION_PARTITION: Record<AuditAction, "parent-only" | "child-permitted"> = {
  // child-permitted: the read-side broker emissions the in-child
  // DefaultCredentialBroker legitimately produces during plugin tool
  // execution. Every other variant is parent-only.
  "credential.client_created": "child-permitted",
  "credential.raw_access":     "child-permitted",
  "credential.raw_denied":     "child-permitted",
  "credential.fetch_created":  "child-permitted",

  // parent-only: lifecycle / store / key-provider / boot
  "credential.passphrase_consumed": "parent-only",
  "credential.store_unlocked":      "parent-only",
  "credential.store_locked":        "parent-only",
  "credential.scrub_disabled":      "parent-only",

  // parent-only: Theme 6 broker write-side events. Every one of these is
  // emitted from the parent CLI (`kuzo credentials *` lands in Theme 7/8),
  // NEVER from the in-child broker. A compromised plugin attempting to
  // emit any of these is caught at the IPC boundary by
  // `plugin-process.handleAuditEvent` (which checks
  // `CHILD_PERMITTED_AUDIT_ACTIONS`) and rewritten as
  // `audit.forged_action`.
  "credential.set":               "parent-only",
  "credential.deleted":           "parent-only",
  "credential.rotated":           "parent-only",
  "credential.migrated":          "parent-only",
  "credential.migration_partial": "parent-only",
  "credential.wiped":             "parent-only",
  "credential.tested":            "parent-only",

  // parent-only: Theme 7 install-time env-name reservation (spec §A.12.4).
  // Produced only by the `kuzo plugins install/update/uninstall` CLI surface.
  "credential.namespace_validated": "parent-only",

  // parent-only: 2.5e Part D plugin lifecycle + 2.5c consent events
  "plugin.loaded":                "parent-only",
  "plugin.skipped":               "parent-only",
  "plugin.failed":                "parent-only",
  "plugin.installed":             "parent-only",
  "plugin.uninstalled":           "parent-only",
  "plugin.updated":               "parent-only",
  "plugin.rolled_back":           "parent-only",
  "plugin.trust_root_refreshed":  "parent-only",
  "consent.granted":              "parent-only",
  "consent.revoked":              "parent-only",
  "consent.checked":              "parent-only",

  // parent-only: this Theme — IPC validator + rate-limit + boot meta
  "audit.forged_plugin_field":   "parent-only",
  "audit.forged_action":         "parent-only",
  "audit.rate_limited":          "parent-only",
  "audit.partition_initialized": "parent-only",
};

/**
 * Derived at module load — no per-call cost. Used by
 * `plugin-process.handleAuditEvent` to gate child IPC traffic against
 * the action-class allowlist.
 *
 * Cast is tightened (round-3 Correctness advisory): scope is the closed
 * `"parent-only" | "child-permitted"` literal union rather than `string`,
 * so the filter callback is typechecked against the actual values.
 */
export const CHILD_PERMITTED_AUDIT_ACTIONS: ReadonlySet<AuditAction> = new Set(
  (
    Object.entries(AUDIT_ACTION_PARTITION) as [
      AuditAction,
      "parent-only" | "child-permitted",
    ][]
  )
    .filter(([, scope]) => scope === "child-permitted")
    .map(([action]) => action),
);
