/**
 * Capability env-naming policy (spec §A.12, round-4 B13).
 *
 * Closes three attacks a Sigstore-signed-but-malicious plugin could otherwise
 * mount by declaring an arbitrary `CredentialCapability.env` string:
 *   1. Boot breakage  — `env: "PATH"` → scrub deletes `process.env.PATH`.
 *   2. Credential aliasing — `env: "GITHUB_TOKEN"` from a non-github plugin.
 *   3. Passphrase capture  — `env: "KUZO_PASSPHRASE"` with `access: "raw"`.
 *
 * Enforced at INSTALL TIME (`kuzo plugins install`), before any state mutation,
 * via {@link validateEnvNames}. The first-party reservation table is hardcoded
 * (NOT config-driven — same security property as the 2.5e plugin-resolver map);
 * third-party claims are materialized in a 0600 registry under `$KUZO_HOME`.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";

import { envNamespaceFilePath, kuzoHome } from "../paths.js";

// ─── §A.12.1 First-party reservation table ──────────────────────────────────

/**
 * Which env names each first-party plugin owns forever. Hardcoded; the github
 * plugin owns `GITHUB_TOKEN` and no third-party plugin can ever declare it.
 *
 * Build-time parity (`scripts/check-plugin-manifest-parity.mjs`, §A.12.1)
 * asserts each first-party plugin's `kuzoPlugin.capabilities` credential envs
 * equal the row below — drift fails the build.
 */
export const FIRST_PARTY_ENV_RESERVATIONS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "@kuzo-mcp/plugin-github": ["GITHUB_TOKEN", "GITHUB_USERNAME"],
    "@kuzo-mcp/plugin-jira": ["JIRA_HOST", "JIRA_EMAIL", "JIRA_API_TOKEN"],
    "@kuzo-mcp/plugin-git-context": [],
  });

// ─── §A.12.3 check 1 — format ────────────────────────────────────────────────

/**
 * Env names must be uppercase, start with a letter, and be 3–64 chars total.
 * Rejects shell-meta injection, lowercase, lone-digit prefixes, over-length.
 */
export const ENV_NAME_FORMAT = /^[A-Z][A-Z0-9_]{2,63}$/;

// ─── §A.12.3 check 2 — reserved-system denylist ─────────────────────────────

/** System / kuzo env names a plugin may never claim (prefix patterns included). */
export const RESERVED_SYSTEM_ENVS: readonly RegExp[] = [
  /^PATH$/, /^HOME$/, /^USER$/, /^SHELL$/,
  /^TERM$/, /^LANG$/, /^PWD$/, /^OLDPWD$/,
  /^TMPDIR$/, /^TMP$/, /^TEMP$/, /^DISPLAY$/,
  /^NODE_ENV$/, /^NODE_OPTIONS$/, /^DEBUG$/,
  /^NODE_.*/, /^NPM_.*/, /^npm_.*/, /^XDG_.*/,
  /^DBUS_.*/, /^WAYLAND_.*/, /^SSH_.*/,
  /^LD_.*/, /^DYLD_.*/, // dynamic-linker injection family (round-1 Security advisory)
  /^KUZO_.*/, // catches KUZO_PASSPHRASE, KUZO_HOME, KUZO_NO_ENV_SCRUB, etc.
];

// ─── Errors ──────────────────────────────────────────────────────────────────

export type EnvNamespaceErrorCode =
  | "E_INVALID_ENV_NAME_FORMAT" // exit 70
  | "E_RESERVED_SYSTEM_ENV" // exit 67
  | "E_RESERVED_FIRST_PARTY_ENV" // exit 68
  | "E_ENV_NAME_COLLISION"; // exit 69

/** Thrown by {@link validateEnvNames} on the first failing check. */
export class EnvNamespaceError extends Error {
  override name = "EnvNamespaceError" as const;
  readonly code: EnvNamespaceErrorCode;
  /** The offending `CredentialCapability.env` value. */
  readonly envName: string;
  constructor(code: EnvNamespaceErrorCode, envName: string, message: string) {
    super(message);
    this.code = code;
    this.envName = envName;
  }
}

/**
 * §B.10 process exit code for an env-name reservation failure. Single owner so
 * the `kuzo plugins install` / `update` error mappers don't each duplicate the
 * code table.
 */
export function exitCodeForEnvNamespaceError(err: EnvNamespaceError): number {
  switch (err.code) {
    case "E_RESERVED_SYSTEM_ENV":
      return 67;
    case "E_RESERVED_FIRST_PARTY_ENV":
      return 68;
    case "E_ENV_NAME_COLLISION":
      return 69;
    case "E_INVALID_ENV_NAME_FORMAT":
      return 70;
  }
}

// ─── §A.12.2 Local namespace registry ───────────────────────────────────────

export const ENV_NAMESPACE_FORMAT_VERSION = 1 as const;

export interface EnvNamespaceRegistry {
  format_version: typeof ENV_NAMESPACE_FORMAT_VERSION;
  lastUpdated: string;
  /** Package name → the env names that package has claimed. */
  plugins: Record<string, string[]>;
}

function emptyRegistry(): EnvNamespaceRegistry {
  return {
    format_version: ENV_NAMESPACE_FORMAT_VERSION,
    lastUpdated: new Date(0).toISOString(),
    plugins: {},
  };
}

/**
 * Read `$KUZO_HOME/env-namespace.json`. Returns an empty registry if the file
 * doesn't exist (fresh install). Throws on malformed content or an unsupported
 * `format_version` — fail-closed, because a registry we can't trust can't gate
 * collisions safely.
 */
export function readEnvNamespaceRegistry(): EnvNamespaceRegistry {
  const path = envNamespaceFilePath();
  if (!existsSync(path)) return emptyRegistry();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error(
      `${path} is not valid JSON. Remove it to reset the env-name registry (you will need to re-install third-party plugins).`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${path} is not a JSON object.`);
  }
  const r = parsed as Record<string, unknown>;
  if (r.format_version !== ENV_NAMESPACE_FORMAT_VERSION) {
    throw new Error(
      `${path} has unsupported format_version ${String(r.format_version)}; expected ${ENV_NAMESPACE_FORMAT_VERSION}. This kuzo version is too old to read it.`,
    );
  }
  if (r.plugins === null || typeof r.plugins !== "object" || Array.isArray(r.plugins)) {
    throw new Error(`${path} \`plugins\` field is not an object.`);
  }
  const plugins: Record<string, string[]> = {};
  for (const [pkg, envs] of Object.entries(r.plugins as Record<string, unknown>)) {
    if (!Array.isArray(envs) || envs.some((e) => typeof e !== "string")) {
      throw new Error(`${path} entry for "${pkg}" is not a string array.`);
    }
    plugins[pkg] = envs as string[];
  }
  return {
    format_version: ENV_NAMESPACE_FORMAT_VERSION,
    lastUpdated: typeof r.lastUpdated === "string" ? r.lastUpdated : new Date().toISOString(),
    plugins,
  };
}

/** Atomic write of the registry (mode 0600, parent dir 0700, tmp + rename). */
export function writeEnvNamespaceRegistry(registry: EnvNamespaceRegistry): void {
  mkdirSync(kuzoHome(), { recursive: true, mode: 0o700 });
  const path = envNamespaceFilePath();
  const tmp = `${path}.tmp`;
  const serialized: EnvNamespaceRegistry = {
    format_version: ENV_NAMESPACE_FORMAT_VERSION,
    lastUpdated: new Date().toISOString(),
    plugins: registry.plugins,
  };
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(serialized, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/** Pure: return a registry with `packageName`'s claimed envs set to `envNames`. */
export function upsertPluginEnvNames(
  registry: EnvNamespaceRegistry,
  packageName: string,
  envNames: readonly string[],
): EnvNamespaceRegistry {
  return {
    ...registry,
    plugins: { ...registry.plugins, [packageName]: [...envNames] },
  };
}

/** Pure: return a registry with `packageName`'s row removed (envs reclaimable). */
export function removePluginEnvNames(
  registry: EnvNamespaceRegistry,
  packageName: string,
): EnvNamespaceRegistry {
  const plugins = { ...registry.plugins };
  delete plugins[packageName];
  return { ...registry, plugins };
}

// ─── §A.12.3 Install-time validation ─────────────────────────────────────────

export interface ValidateEnvNamesArgs {
  /** Candidate package being installed/updated (e.g. "@scope/plugin-foo"). */
  packageName: string;
  /** Every `CredentialCapability.env` the candidate declares (required + optional). */
  envNames: readonly string[];
  /** Current local namespace registry, for the cross-plugin collision check. */
  registry: EnvNamespaceRegistry;
}

/**
 * Run the four §A.12.3 checks, in order, for every declared env name. Throws
 * {@link EnvNamespaceError} on the first failure; returns normally when all
 * envs pass. Performs no I/O and no mutation — the caller persists the registry
 * after a clean pass.
 */
export function validateEnvNames(args: ValidateEnvNamesArgs): void {
  const { packageName, envNames, registry } = args;
  for (const name of envNames) {
    // Check 1 (C3) — format.
    if (!ENV_NAME_FORMAT.test(name)) {
      throw new EnvNamespaceError(
        "E_INVALID_ENV_NAME_FORMAT",
        name,
        `${packageName} declares CredentialCapability "${name}" which is not a valid env-var name. Must match ${ENV_NAME_FORMAT.source} (uppercase, letter-led, 3–64 chars).`,
      );
    }

    // Check 2 (C1) — reserved-system denylist.
    if (RESERVED_SYSTEM_ENVS.some((re) => re.test(name))) {
      throw new EnvNamespaceError(
        "E_RESERVED_SYSTEM_ENV",
        name,
        `"${name}" is a reserved system / kuzo env var; pick a different name.`,
      );
    }

    // Check 3 (C2 primary) — first-party reservation.
    for (const [owner, reservedEnvs] of Object.entries(FIRST_PARTY_ENV_RESERVATIONS)) {
      if (owner !== packageName && reservedEnvs.includes(name)) {
        throw new EnvNamespaceError(
          "E_RESERVED_FIRST_PARTY_ENV",
          name,
          `${packageName} declares CredentialCapability "${name}" which is reserved for ${owner}.\n` +
            `Pick a different env name (e.g. ${shortName(packageName)}_${name}). If your plugin needs ${owner}'s credential, declare a CrossPluginCapability that calls the first-party plugin's tool via callTool().`,
        );
      }
    }

    // Check 4 (C2 secondary) — cross-plugin collision in the local registry.
    for (const [other, claimedEnvs] of Object.entries(registry.plugins)) {
      if (other !== packageName && claimedEnvs.includes(name)) {
        throw new EnvNamespaceError(
          "E_ENV_NAME_COLLISION",
          name,
          `${packageName} declares CredentialCapability "${name}" which is already claimed by ${other}.\n` +
            `Pick a different env name, or uninstall ${other} if you intended this plugin to replace it.`,
        );
      }
    }
  }
}

/** Best-effort shorthand for the 68-error remediation hint (e.g. "plugin-stripe" → "STRIPE"). */
function shortName(packageName: string): string {
  const last = packageName.includes("/")
    ? packageName.slice(packageName.lastIndexOf("/") + 1)
    : packageName;
  return last.replace(/^plugin-/, "").replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
}
