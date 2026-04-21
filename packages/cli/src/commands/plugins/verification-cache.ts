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
import { dirname } from "node:path";

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
 * Returns `undefined` when the file is missing or malformed — both are
 * treated as cache misses by `verify`. Never throws on parse failure; the
 * file is non-authoritative (spec §C.8).
 */
export function readVerificationCache(
  name: string,
  version: string,
): CachedVerification | undefined {
  const path = verificationJsonPath(name, version);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as CachedVerification;
    if (parsed.schemaVersion !== VERIFICATION_SCHEMA_VERSION) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
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
    `${targetDir}/verification.json`,
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
  const dir = dirname(verificationJsonPath(name, version));
  writeVerificationFile(dir, evidence, policy);
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
