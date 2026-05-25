/**
 * "Which plugin owns which env" resolution for `status` and `test`.
 *
 * Source of truth = the first-party reservation table (always present, even in
 * dev where first-party plugins aren't `kuzo plugins install`-ed) merged with
 * the local env-namespace registry (installed third-party). The §A.12 install
 * gate guarantees envs are unique across plugins, so a name maps to at most one.
 */

import {
  FIRST_PARTY_ENV_RESERVATIONS,
  readEnvNamespaceRegistry,
} from "@kuzo-mcp/core/credentials";

export interface PluginEnvGroup {
  display: string;
  packageName: string;
  envs: string[];
  firstParty: boolean;
}

const PACKAGE_DISPLAY: Readonly<Record<string, string>> = {
  "@kuzo-mcp/plugin-github": "github",
  "@kuzo-mcp/plugin-jira": "jira",
  "@kuzo-mcp/plugin-git-context": "git-context",
};

function displayName(pkg: string): string {
  return PACKAGE_DISPLAY[pkg] ?? pkg;
}

/** First-party reservations + installed third-party rows from the registry. */
export function knownPluginEnvs(): PluginEnvGroup[] {
  const groups: PluginEnvGroup[] = [];
  for (const [pkg, envs] of Object.entries(FIRST_PARTY_ENV_RESERVATIONS)) {
    groups.push({ display: displayName(pkg), packageName: pkg, envs: [...envs], firstParty: true });
  }
  let registryPlugins: Record<string, string[]> = {};
  try {
    registryPlugins = readEnvNamespaceRegistry().plugins;
  } catch {
    // Corrupt/unreadable registry — first-party reservations still apply.
  }
  for (const [pkg, envs] of Object.entries(registryPlugins)) {
    if (pkg in FIRST_PARTY_ENV_RESERVATIONS) continue; // already covered
    groups.push({ display: displayName(pkg), packageName: pkg, envs: [...envs], firstParty: false });
  }
  return groups;
}

/** Which first-party service (with a built-in probe) owns `name`, if any. */
export function firstPartyServiceForEnv(name: string): "github" | "jira" | undefined {
  if (FIRST_PARTY_ENV_RESERVATIONS["@kuzo-mcp/plugin-github"]?.includes(name)) return "github";
  if (FIRST_PARTY_ENV_RESERVATIONS["@kuzo-mcp/plugin-jira"]?.includes(name)) return "jira";
  return undefined;
}

/** The installed third-party package that declared `name`, if any. */
export function thirdPartyOwnerForEnv(name: string): string | undefined {
  for (const group of knownPluginEnvs()) {
    if (!group.firstParty && group.envs.includes(name)) return group.packageName;
  }
  return undefined;
}

/** Every declared env across all known plugins (for `collectEnvOverrides`). */
export function allKnownEnvNames(): Set<string> {
  const names = new Set<string>();
  for (const group of knownPluginEnvs()) {
    for (const env of group.envs) names.add(env);
  }
  return names;
}
