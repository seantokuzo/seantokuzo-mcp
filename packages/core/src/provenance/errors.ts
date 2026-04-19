/**
 * Provenance verification error codes and exit code mapping.
 *
 * Codes 10–19 reserved for the provenance domain per docs/2.5e-spec.md §C.7.
 * Each code maps to a numeric exit code the CLI surfaces to the shell;
 * multiple semantic codes may share a single exit number when the user fix
 * is identical (e.g. all SLSA-payload-shape issues exit 18).
 */

export const PROVENANCE_ERROR_CODES = {
  E_NO_ATTESTATION: 10,
  E_REGISTRY_NETWORK: 11,
  E_MALFORMED_ATTESTATION: 12,
  E_SIGNATURE_INVALID: 13,
  E_TUF_FETCH: 14,
  E_SUBJECT_MISMATCH: 15,
  E_INTEGRITY_MISMATCH: 15,
  E_DISALLOWED_BUILDER: 16,
  E_THIRD_PARTY_BLOCKED: 17,
  E_WRONG_PREDICATE: 18,
  E_MISSING_REPO: 18,
  E_MALFORMED_REPO: 18,
  E_UNSUPPORTED_HOST: 18,
  E_MALFORMED_SLSA: 18,
} as const satisfies Record<string, number>;

export type ProvenanceErrorCode = keyof typeof PROVENANCE_ERROR_CODES;

export function exitCodeFor(code: ProvenanceErrorCode): number {
  return PROVENANCE_ERROR_CODES[code];
}

/** Thrown form for callers that prefer try/catch over Result. */
export class ProvenanceError extends Error {
  readonly code: ProvenanceErrorCode;
  readonly exitCode: number;

  constructor(code: ProvenanceErrorCode, message: string) {
    super(message);
    this.name = "ProvenanceError";
    this.code = code;
    this.exitCode = PROVENANCE_ERROR_CODES[code];
  }
}
