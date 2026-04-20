/**
 * Public surface for `@kuzo-mcp/core/provenance`.
 *
 * Part C is a pure library — Part D's `kuzo plugins install` consumes
 * `verifyPackageProvenance` and maps `Result.code` → numeric exit code via
 * `exitCodeFor()`.
 */

export {
  PROVENANCE_ERROR_CODES,
  ProvenanceError,
  exitCodeFor,
  type ProvenanceErrorCode,
} from "./errors.js";

export {
  DEFAULT_POLICY,
  evaluate,
  type InTotoStatement,
  type PolicyResult,
  type TrustPolicy,
} from "./policy.js";

export {
  verifyPackageProvenance,
  type Result,
  type VerifiedAttestation,
  type VerifyOptions,
} from "./verify.js";
