/**
 * Pre-install npm provenance verification.
 *
 * Mirrors `pacote/lib/registry.js` (the `verifyAttestations` path) plus a
 * SLSA trust-policy layer on top. Returns a discriminated `Result` so the
 * Part D install CLI can map directly onto exit codes (§C.7) without
 * try/catch chains.
 *
 * Algorithm (docs/2.5e-spec.md §C.1, lib portion = steps 3, 5, 6):
 *
 * 1. pacote.manifest(spec, { verifyAttestations: false }) — no install scripts,
 *    no attestation verify yet (we do our own). Pulls _integrity + dist.attestations.
 * 2. GET <dist.attestations.url with host rewritten to active registry>.
 * 3. For each attestation:
 *      a. Decode in-toto statement from bundle.dsseEnvelope.payload (base64 JSON).
 *      b. Subject check: subject[0].name === PURL && subject[0].digest.sha512 === hex(integrity).
 *      c. If keyed (keyid present), look up registry public key + verify it had
 *         not expired at the bundle's tlog integratedTime.
 *      d. sigstore.verify(bundle, { tufCachePath, tufForceCache, keySelector? }).
 * 4. Apply TrustPolicy to the SLSA provenance attestation → first-party / repo / builder.
 *
 * Returns a frozen evidence object on success.
 */

import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { join } from "node:path";

// pacote is CJS; Node ESM only exposes its `module.exports` via the default
// import. `import * as pacote` would put it under `pacote.default` only.
import pacote from "pacote";
import { verify as sigstoreVerify } from "sigstore";
import type { SerializedBundle } from "@sigstore/bundle";

import type { PluginLogger } from "@kuzo-mcp/types";

import { type ProvenanceErrorCode } from "./errors.js";
import {
  evaluate as evaluatePolicy,
  type InTotoStatement,
  type TrustPolicy,
} from "./policy.js";

export type VerifyOptions = {
  /** npm registry URL. Defaults to https://registry.npmjs.org/. */
  registry?: string;
  /** Sigstore TUF cache directory. Defaults to ~/.kuzo/tuf-cache. */
  tufCachePath?: string;
  /** Optional structured logger; debug-level events on success/failure. */
  logger?: PluginLogger;
  /** Replaceable fetch implementation (testing). */
  fetch?: typeof globalThis.fetch;
};

export type VerifiedAttestation = {
  package: { name: string; version: string; integrity: string };
  firstParty: boolean;
  repo: string;
  builder: string;
  predicateTypes: string[];
  attestationsCount: number;
  verifiedAt: string;
};

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; code: ProvenanceErrorCode; message: string };

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const SLSA_V1_PREDICATE = "https://slsa.dev/provenance/v1";

type RegistryKey = {
  keyid: string;
  expires: string | null;
  keytype: string;
  scheme: string;
  /** base64-encoded DER SubjectPublicKeyInfo */
  key: string;
};

type AttestationsResponse = {
  attestations: Array<{ predicateType: string; bundle: SerializedBundle }>;
};

type DistWithAttestations = {
  integrity?: string;
  tarball?: string;
  attestations?: { url: string; provenance?: { predicateType?: string } } | null;
};

function fail(
  code: ProvenanceErrorCode,
  message: string,
): { ok: false; code: ProvenanceErrorCode; message: string } {
  return { ok: false, code, message };
}

function defaultTufCachePath(): string {
  return join(homedir(), ".kuzo", "tuf-cache");
}

/** Build a Package URL per package-url spec; matches `npm-package-arg` toPurl. */
function constructPurl(name: string, version: string): string {
  // Scoped names (`@scope/pkg`) percent-encode the leading `@` only.
  const encodedName = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encodedName}@${version}`;
}

/** Decode an SRI integrity string (`sha512-<base64>`) to a lowercase hex digest. */
function integrityToHexDigest(integrity: string): string | null {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!match || !match[1]) return null;
  return Buffer.from(match[1], "base64").toString("hex");
}

/** Wrap a base64-encoded DER SubjectPublicKeyInfo as a PEM-formatted public key. */
function derToPem(base64Der: string): string {
  const wrapped = base64Der.match(/.{1,64}/g)?.join("\n") ?? base64Der;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = "HttpStatusError";
  }
}

async function fetchJson<T>(
  url: string,
  fetcher: typeof globalThis.fetch,
): Promise<T> {
  const res = await fetcher(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new HttpStatusError(res.status, url);
  return (await res.json()) as T;
}

type Decoded = {
  predicateType: string;
  bundle: SerializedBundle;
  statement: InTotoStatement;
  /** `null` for keyless (Sigstore/Fulcio) bundles. */
  keyid: string | null;
};

function decodeStatement(
  bundle: SerializedBundle,
): { ok: true; statement: InTotoStatement; keyid: string | null } | { ok: false; reason: string } {
  const dsse = bundle.dsseEnvelope;
  if (!dsse) {
    return { ok: false, reason: "bundle missing dsseEnvelope" };
  }
  let statement: InTotoStatement;
  try {
    statement = JSON.parse(
      Buffer.from(dsse.payload, "base64").toString("utf8"),
    ) as InTotoStatement;
  } catch (e) {
    return {
      ok: false,
      reason: `dsseEnvelope.payload is not valid base64-JSON: ${(e as Error).message}`,
    };
  }
  const rawKeyid = dsse.signatures[0]?.keyid ?? "";
  return {
    ok: true,
    statement,
    keyid: rawKeyid === "" ? null : rawKeyid,
  };
}

/**
 * Verify npm provenance for a published package version. Returns a Result:
 * - `{ok: true, value}` if every attestation passed Sigstore verification AND
 *   the SLSA provenance attestation passed the trust policy.
 * - `{ok: false, code, message}` otherwise; `code` maps to a numeric exit
 *   code via `PROVENANCE_ERROR_CODES`.
 *
 * Pure library — does NOT install, extract, or write to disk (apart from the
 * Sigstore TUF cache, which is read-mostly). Caller (Part D CLI) handles
 * staging, atomic install, consent, and registry mutation.
 */
export async function verifyPackageProvenance(
  name: string,
  version: string,
  policy: TrustPolicy,
  opts: VerifyOptions = {},
): Promise<Result<VerifiedAttestation>> {
  const fetcher = opts.fetch ?? globalThis.fetch;
  const registry = opts.registry ?? DEFAULT_REGISTRY;
  const tufCachePath = opts.tufCachePath ?? defaultTufCachePath();
  const logger = opts.logger;
  const purl = constructPurl(name, version);

  // Step 1 — resolve the manifest. No tarball, no install scripts.
  let manifest: Awaited<ReturnType<typeof pacote.manifest>>;
  try {
    manifest = await pacote.manifest(`${name}@${version}`, {
      registry,
      verifyAttestations: false,
    });
  } catch (e) {
    return fail(
      "E_REGISTRY_NETWORK",
      `pacote.manifest failed for ${name}@${version}: ${(e as Error).message}`,
    );
  }

  const dist = (manifest as { dist?: DistWithAttestations }).dist;
  if (!dist?.integrity) {
    return fail(
      "E_REGISTRY_NETWORK",
      `${name}@${version} packument missing dist.integrity`,
    );
  }
  const expectedHexDigest = integrityToHexDigest(dist.integrity);
  if (!expectedHexDigest) {
    return fail(
      "E_MALFORMED_ATTESTATION",
      `unsupported integrity format: '${dist.integrity}' (sha512-<base64> required)`,
    );
  }
  if (!dist.attestations?.url) {
    return fail(
      "E_NO_ATTESTATION",
      `no provenance attestation for ${name}@${version}`,
    );
  }

  // Step 2 — fetch attestations payload, rewriting host to active registry
  // (matches pacote — lets private mirrors proxy attestations).
  const attestationsPath = new URL(dist.attestations.url).pathname;
  const attestationsUrl = new URL(attestationsPath, registry).href;
  let response: AttestationsResponse;
  try {
    response = await fetchJson<AttestationsResponse>(attestationsUrl, fetcher);
  } catch (e) {
    if (e instanceof HttpStatusError) {
      const code: ProvenanceErrorCode =
        e.status === 404 ? "E_NO_ATTESTATION" : "E_REGISTRY_NETWORK";
      return fail(
        code,
        `attestation fetch failed (HTTP ${e.status}) for ${attestationsUrl}`,
      );
    }
    return fail(
      "E_REGISTRY_NETWORK",
      `attestation fetch failed for ${attestationsUrl}: ${(e as Error).message}`,
    );
  }
  const rawAttestations = response.attestations ?? [];
  if (rawAttestations.length === 0) {
    return fail(
      "E_NO_ATTESTATION",
      `attestation response for ${name}@${version} contained zero entries`,
    );
  }

  // Step 3 — decode statements + collect keyids
  const decoded: Decoded[] = [];
  for (const att of rawAttestations) {
    const result = decodeStatement(att.bundle);
    if (!result.ok) {
      return fail("E_MALFORMED_ATTESTATION", result.reason);
    }
    decoded.push({
      predicateType: att.predicateType,
      bundle: att.bundle,
      statement: result.statement,
      keyid: result.keyid,
    });
  }

  // Step 4 — fetch registry keys when there are keyed (publish) attestations
  const keyedAttestations = decoded.filter(
    (d): d is Decoded & { keyid: string } => d.keyid !== null,
  );
  const pemByKeyid = new Map<string, string>();
  const expiresByKeyid = new Map<string, string | null>();
  if (keyedAttestations.length > 0) {
    const keysUrl = new URL("/-/npm/v1/keys", registry).href;
    let keysResponse: { keys?: RegistryKey[] };
    try {
      keysResponse = await fetchJson<{ keys?: RegistryKey[] }>(
        keysUrl,
        fetcher,
      );
    } catch (e) {
      return fail(
        "E_REGISTRY_NETWORK",
        `failed to fetch registry keys from ${keysUrl}: ${(e as Error).message}`,
      );
    }
    for (const k of keysResponse.keys ?? []) {
      pemByKeyid.set(k.keyid, derToPem(k.key));
      expiresByKeyid.set(k.keyid, k.expires);
    }

    for (const att of keyedAttestations) {
      if (!pemByKeyid.has(att.keyid)) {
        return fail(
          "E_SIGNATURE_INVALID",
          `attestation keyid '${att.keyid}' not found in registry keys at ${keysUrl}`,
        );
      }
      const tlogEntry = att.bundle.verificationMaterial?.tlogEntries[0];
      if (!tlogEntry?.integratedTime) {
        return fail(
          "E_MALFORMED_ATTESTATION",
          "keyed attestation missing verificationMaterial.tlogEntries[0].integratedTime",
        );
      }
      const integratedAt = new Date(Number(tlogEntry.integratedTime) * 1000);
      const expires = expiresByKeyid.get(att.keyid);
      if (expires && integratedAt > new Date(expires)) {
        return fail(
          "E_SIGNATURE_INVALID",
          `keyid '${att.keyid}' was expired at integration time ${integratedAt.toISOString()} (expires ${expires})`,
        );
      }
    }
  }

  // Step 5 — per-attestation: subject check + sigstore.verify
  for (const att of decoded) {
    const subject = att.statement.subject?.[0];
    if (!subject?.name || !subject.digest?.sha512) {
      return fail(
        "E_MALFORMED_SLSA",
        `attestation (${att.predicateType}) subject malformed`,
      );
    }
    if (subject.name !== purl) {
      return fail(
        "E_SUBJECT_MISMATCH",
        `attestation (${att.predicateType}) signed '${subject.name}', expected '${purl}'`,
      );
    }
    if (subject.digest.sha512 !== expectedHexDigest) {
      return fail(
        "E_INTEGRITY_MISMATCH",
        `attestation (${att.predicateType}) sha512 mismatch (signed '${subject.digest.sha512}', integrity '${expectedHexDigest}')`,
      );
    }

    const pem = att.keyid ? pemByKeyid.get(att.keyid) : undefined;
    try {
      await sigstoreVerify(att.bundle, {
        tufCachePath,
        tufForceCache: true,
        keySelector: pem ? () => pem : undefined,
      });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const lower = msg.toLowerCase();
      const code: ProvenanceErrorCode =
        lower.includes("tuf") || lower.includes("trust root")
          ? "E_TUF_FETCH"
          : "E_SIGNATURE_INVALID";
      return fail(
        code,
        `sigstore.verify failed for ${att.predicateType}: ${msg}`,
      );
    }
  }

  // Step 6 — apply trust policy to the SLSA provenance attestation
  const slsa = decoded.find(
    (d) => d.statement.predicateType === SLSA_V1_PREDICATE,
  );
  if (!slsa) {
    return fail(
      "E_MALFORMED_SLSA",
      `no SLSA provenance v1 attestation in payload (got: ${decoded.map((d) => d.predicateType).join(", ")})`,
    );
  }
  const policyResult = evaluatePolicy(slsa.statement, policy);
  if (!policyResult.verified) {
    return fail(policyResult.code, policyResult.reason);
  }

  logger?.debug?.(`provenance verified for ${name}@${version}`, {
    firstParty: policyResult.firstParty,
    repo: policyResult.repo,
    builder: policyResult.builder,
    attestationsCount: decoded.length,
    predicateTypes: decoded.map((d) => d.predicateType),
  });

  return {
    ok: true,
    value: {
      package: { name, version, integrity: dist.integrity },
      firstParty: policyResult.firstParty,
      repo: policyResult.repo,
      builder: policyResult.builder,
      predicateTypes: decoded.map((d) => d.predicateType),
      attestationsCount: decoded.length,
      verifiedAt: new Date().toISOString(),
    },
  };
}
