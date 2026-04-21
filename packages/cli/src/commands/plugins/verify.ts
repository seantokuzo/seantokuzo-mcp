/**
 * `kuzo plugins verify <name>` — re-run Part C verification against an
 * installed plugin (spec §D.1).
 *
 * Read-only: no lock acquisition, no audit emission, no consent change.
 *
 * Cache logic per spec §C.8:
 *   - Read `<name>/<version>/verification.json`
 *   - If present AND `policySnapshot` matches the current TrustPolicy → success
 *     (print "verified (cached)" + originally-verified date) and exit 0
 *   - Else (file missing, malformed, schema bump, snapshot mismatch, or
 *     `--no-cache`): re-fetch attestations, re-run sigstore verification,
 *     rewrite verification.json with the fresh evidence + current policy
 *
 * Exit codes:
 *   - 0 on success
 *   - 10-19 from @kuzo-mcp/core/provenance on signature/policy regression
 *   - 48 (E_NOT_INSTALLED) when name doesn't match any installed plugin
 *   - 1 on unexpected errors
 */

import boxen from "boxen";
import chalk from "chalk";
import { createSpinner } from "nanospinner";

import {
  DEFAULT_POLICY,
  exitCodeFor,
  type ProvenanceErrorCode,
  type TrustPolicy,
  verifyPackageProvenance,
} from "@kuzo-mcp/core/provenance";

import { readIndex, type PluginIndexEntry } from "./state.js";
import {
  policiesEqual,
  readVerificationCache,
  rewriteVerificationCache,
} from "./verification-cache.js";

export interface VerifyOptions {
  allowThirdParty?: boolean;
  allowBuilder?: string[];
  allowRegistry?: string;
  registry?: string;
  /** Force re-fetch even if cache is valid (debugging / paranoia). */
  noCache?: boolean;
}

const NPM_REGISTRY = "https://registry.npmjs.org/";

export async function runVerify(
  nameArg: string,
  options: VerifyOptions,
): Promise<void> {
  const index = readIndex();
  const resolved = resolveInstalled(index.plugins, nameArg);
  if (!resolved) {
    throw new VerifyError(
      "E_NOT_INSTALLED",
      notInstalledMessage(nameArg, Object.keys(index.plugins)),
    );
  }
  const { friendlyName, entry } = resolved;
  const policy = buildPolicy(options);
  const registry = resolveRegistry(options);

  // --- Cache path -----------------------------------------------------------
  if (!options.noCache) {
    const cached = readVerificationCache(friendlyName, entry.currentVersion);
    if (cached?.policySnapshot && policiesEqual(cached.policySnapshot, policy)) {
      printSuccess(friendlyName, entry, {
        cached: true,
        verifiedAt: cached.verifiedAt,
        firstParty: cached.firstParty,
        attestationsCount: cached.attestationsCount,
        repo: cached.repo,
        builder: cached.builder,
      });
      return;
    }
  }

  // --- Re-verify path -------------------------------------------------------
  const spinner = createSpinner(
    `Verifying ${entry.packageName}@${entry.currentVersion}...`,
  ).start();

  const result = await verifyPackageProvenance(
    entry.packageName,
    entry.currentVersion,
    policy,
    { registry },
  );

  if (!result.ok) {
    spinner.error({ text: `Verification failed: ${result.message}` });
    throw new ProvenanceFailure(result.code, result.message);
  }

  spinner.success({
    text: `Verified ${entry.packageName}@${result.value.package.version} (${result.value.firstParty ? "first-party" : "third-party"}, ${result.value.attestationsCount} attestations)`,
  });

  // Refresh the per-version cache so subsequent verifies hit the fast path.
  rewriteVerificationCache(
    friendlyName,
    entry.currentVersion,
    result.value,
    policy,
  );

  printSuccess(friendlyName, entry, {
    cached: false,
    verifiedAt: result.value.verifiedAt,
    firstParty: result.value.firstParty,
    attestationsCount: result.value.attestationsCount,
    repo: result.value.repo,
    builder: result.value.builder,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveInstalled(
  plugins: Record<string, PluginIndexEntry>,
  nameArg: string,
): { friendlyName: string; entry: PluginIndexEntry } | undefined {
  if (plugins[nameArg]) {
    return { friendlyName: nameArg, entry: plugins[nameArg] };
  }
  for (const [name, entry] of Object.entries(plugins)) {
    if (entry.packageName === nameArg) {
      return { friendlyName: name, entry };
    }
  }
  return undefined;
}

function notInstalledMessage(nameArg: string, installed: string[]): string {
  const head = `"${nameArg}" is not installed.`;
  if (installed.length === 0) {
    return `${head} No plugins are currently installed.`;
  }
  return `${head} Installed: ${installed.sort().join(", ")}`;
}

function buildPolicy(options: VerifyOptions): TrustPolicy {
  return {
    allowedBuilders: [
      ...DEFAULT_POLICY.allowedBuilders,
      ...(options.allowBuilder ?? []),
    ],
    firstPartyOrgs: [...DEFAULT_POLICY.firstPartyOrgs],
    allowThirdParty:
      options.allowThirdParty ?? DEFAULT_POLICY.allowThirdParty,
  };
}

function resolveRegistry(options: VerifyOptions): string {
  const requested = options.registry ?? options.allowRegistry;
  if (!requested) return NPM_REGISTRY;
  const normalized = requested.endsWith("/") ? requested : `${requested}/`;
  if (normalized !== NPM_REGISTRY && !options.allowRegistry) {
    throw new VerifyError(
      "E_UNSUPPORTED_REGISTRY",
      `Only ${NPM_REGISTRY} is supported by default. Pass --allow-registry <url> to override.`,
    );
  }
  return normalized;
}

interface PrintSuccessArgs {
  cached: boolean;
  verifiedAt: string;
  firstParty: boolean;
  attestationsCount: number;
  repo: string;
  builder: string;
}

function printSuccess(
  friendlyName: string,
  entry: PluginIndexEntry,
  args: PrintSuccessArgs,
): void {
  const firstParty = args.firstParty
    ? chalk.green("✓ first-party")
    : chalk.yellow("third-party");
  const verifiedTag = args.cached
    ? chalk.gray(`(cached, originally verified ${shortDate(args.verifiedAt)})`)
    : chalk.gray(`(re-verified ${shortDate(args.verifiedAt)})`);

  const lines = [
    chalk.green.bold(`✓ ${friendlyName}@${entry.currentVersion} verified`),
    verifiedTag,
    "",
    `${chalk.bold("Package:")}        ${entry.packageName}`,
    `${chalk.bold("Source:")}         ${firstParty}`,
    `${chalk.bold("Attestations:")}   ${String(args.attestationsCount)}`,
  ];
  if (args.repo) {
    lines.push(`${chalk.bold("Repo:")}           ${args.repo}`);
  }
  if (args.builder) {
    lines.push(`${chalk.bold("Builder:")}        ${args.builder}`);
  }

  console.log(
    "\n" +
      boxen(lines.join("\n"), {
        padding: 1,
        borderColor: "green",
        title: "kuzo plugins verify",
        titleAlignment: "left",
      }),
  );
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type VerifyErrorCode = "E_NOT_INSTALLED" | "E_UNSUPPORTED_REGISTRY";

export class VerifyError extends Error {
  readonly code: VerifyErrorCode;
  readonly exitCode: number;
  constructor(code: VerifyErrorCode, message: string) {
    super(message);
    this.name = "VerifyError";
    this.code = code;
    this.exitCode = VERIFY_ERROR_EXIT_CODES[code];
  }
}

const VERIFY_ERROR_EXIT_CODES: Record<VerifyErrorCode, number> = {
  E_NOT_INSTALLED: 48,
  E_UNSUPPORTED_REGISTRY: 41,
};

export class ProvenanceFailure extends Error {
  readonly code: ProvenanceErrorCode;
  readonly exitCode: number;
  constructor(code: ProvenanceErrorCode, message: string) {
    super(message);
    this.name = "ProvenanceFailure";
    this.code = code;
    this.exitCode = exitCodeFor(code);
  }
}

export function exitCodeForVerifyError(err: unknown): number {
  if (err instanceof ProvenanceFailure) return err.exitCode;
  if (err instanceof VerifyError) return err.exitCode;
  return 1;
}
