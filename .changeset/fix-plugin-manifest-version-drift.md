---
"@kuzo-mcp/plugin-git-context": patch
"@kuzo-mcp/plugin-github": patch
"@kuzo-mcp/plugin-jira": patch
---

Fix plugin manifest `version` drift. Plugins now derive their `version` field from their own `package.json` at module load time via `createRequire(import.meta.url)("../package.json")`, so the plugin manifest stays aligned with the package version instead of hardcoding a separate value. Previously all three plugins had `version: "1.0.0"` hardcoded, which collided with the install CLI's `E_VERSION_MISMATCH` safety check when the first real `0.0.1` release shipped — verified Sigstore attestation succeeded but the final install step refused to complete because `manifest.version=1.0.0 !== resolvedVersion=0.0.1`.

No API changes. Only affects what plugin authors write inside their `index.ts`. The install CLI's version-match check is retained as defense-in-depth for third-party plugins that don't follow this convention.
