#!/usr/bin/env node
/**
 * Provenance verification smoke test (Phase 2.5e Part C).
 *
 * Exercises `verifyPackageProvenance()` against three real npm scenarios so
 * we catch wiring bugs before any `@kuzo-mcp/*` package has its own real
 * provenance attestation:
 *
 *   1. sigstore@4.1.0 + permissive policy   → ok, third-party (sigstore-js org)
 *   2. sigstore@4.1.0 + DEFAULT_POLICY      → fail (third-party blocked because
 *                                              firstPartyOrgs = ['seantokuzo'])
 *      — actually DEFAULT_POLICY allowThirdParty=true, so this still passes;
 *      we instead use a "first-party-only" policy variant here.
 *   3. lodash@4.17.21 + DEFAULT_POLICY      → fail E_NO_ATTESTATION
 *
 * Hits real registry + real Sigstore TUF + real Rekor — needs network. Uses
 * an isolated TUF cache under $TMPDIR so it doesn't pollute ~/.kuzo.
 *
 * Usage: pnpm build && node scripts/smoke-provenance.mjs
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  DEFAULT_POLICY,
  verifyPackageProvenance,
} from "../packages/core/dist/provenance/index.js";

const tufCachePath = mkdtempSync(join(tmpdir(), "kuzo-smoke-tuf-"));

let failures = 0;

function pass(name) {
  console.log(`  \u2713 ${name}`);
}
function fail(name, detail) {
  console.error(`  \u2717 ${name}`);
  if (detail) console.error(`      ${detail}`);
  failures += 1;
}

async function main() {
  console.log("[smoke] tuf cache:", tufCachePath);

  // ───────────────────────────────────────────────────────────────────
  // Scenario 1: sigstore@4.1.0 against a permissive policy.
  // sigstore is published by the sigstore GitHub org via github actions.
  // Expect: ok, firstParty=false, builder/repo populated.
  // ───────────────────────────────────────────────────────────────────
  console.log("\n[smoke] sigstore@4.1.0 + permissive policy (allowThirdParty=true)");
  const permissive = { ...DEFAULT_POLICY, firstPartyOrgs: ["seantokuzo"] };
  const r1 = await verifyPackageProvenance(
    "sigstore",
    "4.1.0",
    permissive,
    { tufCachePath },
  );
  if (!r1.ok) {
    fail("expected ok", `got ${r1.code}: ${r1.message}`);
  } else {
    pass(`verified — repo=${r1.value.repo}, builder=${r1.value.builder}`);
    if (r1.value.firstParty !== false) {
      fail("expected firstParty=false", `got ${r1.value.firstParty}`);
    } else {
      pass("firstParty=false (correctly classified third-party)");
    }
    if (r1.value.attestationsCount < 1) {
      fail("expected ≥1 attestations", `got ${r1.value.attestationsCount}`);
    } else {
      pass(`attestationsCount=${r1.value.attestationsCount}`);
    }
    if (!r1.value.predicateTypes.includes("https://slsa.dev/provenance/v1")) {
      fail(
        "expected SLSA v1 predicate present",
        `predicateTypes=${r1.value.predicateTypes.join(",")}`,
      );
    } else {
      pass("SLSA v1 predicate present");
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Scenario 2: sigstore@4.1.0 + first-party-only policy → blocked.
  // ───────────────────────────────────────────────────────────────────
  console.log(
    "\n[smoke] sigstore@4.1.0 + first-party-only policy (allowThirdParty=false)",
  );
  const firstPartyOnly = {
    ...DEFAULT_POLICY,
    allowThirdParty: false,
  };
  const r2 = await verifyPackageProvenance(
    "sigstore",
    "4.1.0",
    firstPartyOnly,
    { tufCachePath },
  );
  if (r2.ok) {
    fail("expected fail E_THIRD_PARTY_BLOCKED", `got ok=${JSON.stringify(r2.value)}`);
  } else if (r2.code !== "E_THIRD_PARTY_BLOCKED") {
    fail("expected E_THIRD_PARTY_BLOCKED", `got ${r2.code}: ${r2.message}`);
  } else {
    pass(`blocked with code=E_THIRD_PARTY_BLOCKED — ${r2.message}`);
  }

  // ───────────────────────────────────────────────────────────────────
  // Scenario 3: lodash@4.17.21 — published 2021, no provenance.
  // Expect: E_NO_ATTESTATION on any policy.
  // ───────────────────────────────────────────────────────────────────
  console.log("\n[smoke] lodash@4.17.21 (no provenance) + DEFAULT_POLICY");
  const r3 = await verifyPackageProvenance(
    "lodash",
    "4.17.21",
    DEFAULT_POLICY,
    { tufCachePath },
  );
  if (r3.ok) {
    fail("expected fail E_NO_ATTESTATION", `got ok=${JSON.stringify(r3.value)}`);
  } else if (r3.code !== "E_NO_ATTESTATION") {
    fail("expected E_NO_ATTESTATION", `got ${r3.code}: ${r3.message}`);
  } else {
    pass(`blocked with code=E_NO_ATTESTATION — ${r3.message}`);
  }

  console.log("");
  if (failures > 0) {
    console.error(`[smoke] ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("[smoke] all assertions passed");
}

try {
  await main();
} finally {
  try {
    rmSync(tufCachePath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}
