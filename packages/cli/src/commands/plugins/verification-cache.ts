/**
 * Per-version frozen verification evidence (`<version>/verification.json`).
 *
 * Spec §C.8 `CachedVerification` — install records the policy that was active
 * when verification ran, plus the verification details. `kuzo plugins verify`
 * reuses this evidence when the active policy still matches; on snapshot
 * mismatch (or missing file) it re-fetches and rewrites.
 *
 * D.1 shipped this file *without* `policySnapshot`. Older installs are still
 * readable here — `policySnapshot` comes back `undefined` and the caller
 * treats that as a forced cache miss. Schema version stays at 1 because the
 * field is purely additive.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { TrustPolicy, VerifiedAttestation } from "@kuzo-mcp/core/provenance";

import { verificationJsonPath } from "./paths.js";

export const VERIFICATION_SCHEMA_VERSION = 1 as const;

export interface CachedVerification {
  schemaVersion: typeof VERIFICATION_SCHEMA_VERSION;
  package: { name: string; version: string; integrity: string };
  verifiedAt: string;
  firstParty: boolean;
  repo: string;
  builder: string;
  predicateTypes: string[];
  attestationsCount: number;
  /**
   * Trust policy in effect at verification time. Spec §C.8 — invalidates the
   * cache when the active policy changes. Optional for back-compat: D.1/D.2
   * installs predate this field; absence means "treat as cache miss".
   */
  policySnapshot?: TrustPolicy;
}

/**
 * Read `<name>/<version>/verification.json` if present.
 *
 * Returns `undefined` when the file is missing, malformed, or fails minimal
 * shape validation. Callers (`verify`, `rollback`) treat that as a cache
 * miss — never throws on parse/shape failure. The file is non-authoritative
 * (spec §C.8), so a corrupt entry cannot grant verification status; it just
 * forces a re-fetch on the next install/verify.
 */
export function readVerificationCache(
  name: string,
  version: string,
): CachedVerification | undefined {
  const path = verificationJsonPath(name, version);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isCachedVerification(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Minimal runtime shape guard — enough to prevent downstream crashes on
 * `cached.package.integrity` and `policiesEqual(cached.policySnapshot, ...)`.
 *
 * We intentionally DON'T validate every field; pre-D.3 installs wrote a
 * narrower shape (no `policySnapshot`) and must still load. The guard
 * enforces exactly what callers dereference, nothing more.
 */
function isCachedVerification(value: unknown): value is CachedVerification {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v["schemaVersion"] !== VERIFICATION_SCHEMA_VERSION) return false;

  const pkg = v["package"];
  if (!pkg || typeof pkg !== "object") return false;
  const p = pkg as Record<string, unknown>;
  if (typeof p["name"] !== "string") return false;
  if (typeof p["version"] !== "string") return false;
  if (typeof p["integrity"] !== "string") return false;

  if (typeof v["verifiedAt"] !== "string") return false;
  if (typeof v["firstParty"] !== "boolean") return false;
  if (typeof v["repo"] !== "string") return false;
  if (typeof v["builder"] !== "string") return false;
  if (!Array.isArray(v["predicateTypes"])) return false;
  if (typeof v["attestationsCount"] !== "number") return false;

  // policySnapshot is optional (D.1/D.2 installs predate it). Shape-check
  // only when present so callers can rely on `policiesEqual(snap, ...)`
  // without re-guarding.
  const snap = v["policySnapshot"];
  if (snap !== undefined) {
    if (!snap || typeof snap !== "object") return false;
    const s = snap as Record<string, unknown>;
    if (!Array.isArray(s["allowedBuilders"])) return false;
    if (!Array.isArray(s["firstPartyOrgs"])) return false;
    if (typeof s["allowThirdParty"] !== "boolean") return false;
  }

  return true;
}

/**
 * Write `verification.json` to an arbitrary directory.
 *
 * `targetDir` is either the staging dir (during install — the file moves
 * with the staging→versioned rename) or a versioned install dir (during
 * verify cache rewrite). Caller picks; this fn just serializes.
 */
export function writeVerificationFile(
  targetDir: string,
  evidence: VerifiedAttestation,
  policy: TrustPolicy,
): void {
  const cached: CachedVerification = {
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
    package: evidence.package,
    verifiedAt: evidence.verifiedAt,
    firstParty: evidence.firstParty,
    repo: evidence.repo,
    builder: evidence.builder,
    predicateTypes: evidence.predicateTypes,
    attestationsCount: evidence.attestationsCount,
    policySnapshot: policy,
  };
  writeFileSync(
    join(targetDir, "verification.json"),
    JSON.stringify(cached, null, 2) + "\n",
    "utf-8",
  );
}

/** Rewrite an installed version's verification.json after a re-verify. */
export function rewriteVerificationCache(
  name: string,
  version: string,
  evidence: VerifiedAttestation,
  policy: TrustPolicy,
): void {
  // path.dirname on the full file path is portable (handles both / and \
  // separators); the earlier regex-based slice broke on Windows.
  writeVerificationFile(
    dirname(verificationJsonPath(name, version)),
    evidence,
    policy,
  );
}

/**
 * Equality check for trust policies — used to decide cache validity in verify.
 *
 * Builders + first-party orgs are compared as sorted-set equality so list
 * ordering doesn't matter. `allowThirdParty` is a strict boolean compare.
 */
export function policiesEqual(a: TrustPolicy, b: TrustPolicy): boolean {
  if (a.allowThirdParty !== b.allowThirdParty) return false;
  return (
    sortedEqual(a.allowedBuilders, b.allowedBuilders) &&
    sortedEqual(a.firstPartyOrgs, b.firstPartyOrgs)
  );
}

function sortedEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const aSorted = [...a].sort();
  const bSorted = [...b].sort();
  return aSorted.every((v, i) => v === bSorted[i]);
}
