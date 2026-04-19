/**
 * SLSA provenance trust policy — applied to an in-toto statement AFTER the
 * Sigstore signature has been cryptographically verified. Decides whether
 * the workflow + builder + repo claimed by the (now-trusted) statement
 * matches our allow-list, and classifies first-party vs third-party.
 *
 * Mirrors docs/2.5e-spec.md §C.5.
 */

import type { ProvenanceErrorCode } from "./errors.js";

/** SLSA v1.0 / in-toto v1 statement shape — only the fields we read. */
export type InTotoStatement = {
  _type: "https://in-toto.io/Statement/v1";
  subject: Array<{ name: string; digest: { sha512: string } }>;
  predicateType: string;
  predicate: {
    buildDefinition?: {
      buildType?: string;
      externalParameters?: {
        workflow?: {
          ref?: string;
          repository?: string;
          path?: string;
        };
      };
      internalParameters?: unknown;
      resolvedDependencies?: Array<{
        uri: string;
        digest: Record<string, string>;
      }>;
    };
    runDetails?: {
      builder?: { id?: string };
      metadata?: {
        invocationId?: string;
        startedOn?: string;
        finishedOn?: string;
      };
    };
  };
};

export type TrustPolicy = {
  /** Builder ID prefixes accepted. Match is exact OR prefix-with-`/`. */
  allowedBuilders: string[];
  /** GitHub orgs whose plugins are classified first-party. */
  firstPartyOrgs: string[];
  /** Reject install when no provenance attestation exists (default true). */
  requireProvenance: boolean;
  /** Permit third-party org plugins (default true; future policy gate). */
  allowThirdParty: boolean;
};

export type PolicyResult =
  | { verified: true; firstParty: boolean; repo: string; builder: string }
  | { verified: false; code: ProvenanceErrorCode; reason: string };

/** Default policy for Kuzo MCP. */
export const DEFAULT_POLICY: TrustPolicy = {
  allowedBuilders: ["https://github.com/actions/runner"],
  firstPartyOrgs: ["seantokuzo"],
  requireProvenance: true,
  allowThirdParty: true,
};

const SLSA_V1 = "https://slsa.dev/provenance/v1";

export function evaluate(
  statement: InTotoStatement,
  policy: TrustPolicy,
): PolicyResult {
  if (statement.predicateType !== SLSA_V1) {
    return {
      verified: false,
      code: "E_WRONG_PREDICATE",
      reason: `expected SLSA provenance v1, got '${statement.predicateType}'`,
    };
  }

  const builder = statement.predicate?.runDetails?.builder?.id ?? "";
  const builderAllowed = policy.allowedBuilders.some(
    (b) => builder === b || builder.startsWith(`${b}/`),
  );
  if (!builderAllowed) {
    return {
      verified: false,
      code: "E_DISALLOWED_BUILDER",
      reason: `builder '${builder}' not in allow-list (${policy.allowedBuilders.join(", ")})`,
    };
  }

  const repoURL =
    statement.predicate?.buildDefinition?.externalParameters?.workflow
      ?.repository;
  if (!repoURL) {
    return {
      verified: false,
      code: "E_MISSING_REPO",
      reason: "workflow.repository absent from SLSA payload",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(repoURL);
  } catch {
    return {
      verified: false,
      code: "E_MALFORMED_REPO",
      reason: `invalid repository URL: '${repoURL}'`,
    };
  }

  if (parsed.host !== "github.com") {
    return {
      verified: false,
      code: "E_UNSUPPORTED_HOST",
      reason: `only github.com supported, got '${parsed.host}'`,
    };
  }

  const org = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
  const firstParty = policy.firstPartyOrgs.includes(org);

  if (!firstParty && !policy.allowThirdParty) {
    return {
      verified: false,
      code: "E_THIRD_PARTY_BLOCKED",
      reason: `third-party plugins disabled; org '${org}' not in firstPartyOrgs`,
    };
  }

  return { verified: true, firstParty, repo: repoURL, builder };
}
