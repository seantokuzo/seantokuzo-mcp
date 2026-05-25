/**
 * Small manifest helpers shared by the install / update commands.
 */

import { isCredentialCapability, type KuzoPluginV2 } from "@kuzo-mcp/types";

/** Credential env names a manifest declares (required + optional). */
export function credentialEnvNames(manifest: KuzoPluginV2): string[] {
  return [...manifest.capabilities, ...(manifest.optionalCapabilities ?? [])]
    .filter(isCredentialCapability)
    .map((c) => c.env);
}
