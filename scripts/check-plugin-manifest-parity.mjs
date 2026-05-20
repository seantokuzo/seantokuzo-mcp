#!/usr/bin/env node
/**
 * scripts/check-plugin-manifest-parity.mjs
 *
 * Wired as `postbuild` in each plugin workspace's package.json. Imports the
 * just-built `dist/index.js` default export and deep-equals its
 * `capabilities` + `optionalCapabilities` arrays against the static
 * `kuzoPlugin.capabilities` + `kuzoPlugin.optionalCapabilities` arrays in
 * the same package.json. Exits non-zero on drift.
 *
 * Required by docs/credentials-spec.md §A.0.1 (round-4 B1). The static
 * package.json mirror is what enables pre-scrub credential-env collection in
 * the credential-source boot sequence (§C.1) — third-party plugins ship
 * arbitrary top-level code so the loader must read capability declarations
 * BEFORE dynamic-importing entry modules. Drift between the static mirror and
 * the runtime manifest is therefore a hard load failure. Catching drift at
 * PR build time prevents publishing a drifted tarball.
 *
 * No CLI args. Resolves `package.json` + `dist/index.js` relative to
 * `process.cwd()` (pnpm sets cwd to the package dir for lifecycle scripts).
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const pkgJsonPath = resolve(cwd, "package.json");
const distEntryPath = resolve(cwd, "dist/index.js");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const pkgRaw = await readFile(pkgJsonPath, "utf8").catch((err) => {
  fail(`could not read ${pkgJsonPath}: ${err.message}`);
});
const pkg = JSON.parse(pkgRaw);
const pkgName = pkg.name ?? "(unknown)";

if (!pkg.kuzoPlugin) {
  fail(`${pkgName}: package.json#kuzoPlugin block is missing.`);
}

const staticCaps = pkg.kuzoPlugin.capabilities;
if (!Array.isArray(staticCaps)) {
  fail(
    `${pkgName}: package.json#kuzoPlugin.capabilities must be an array (spec §A.0.1).`,
  );
}

const staticOpt = pkg.kuzoPlugin.optionalCapabilities ?? [];
if (!Array.isArray(staticOpt)) {
  fail(
    `${pkgName}: package.json#kuzoPlugin.optionalCapabilities must be an array if present.`,
  );
}

const distUrl = pathToFileURL(distEntryPath).href;
let runtimeModule;
try {
  runtimeModule = await import(distUrl);
} catch (err) {
  fail(
    `${pkgName}: failed to import ${distEntryPath} — make sure \`tsc\` ran first. ${err instanceof Error ? err.message : String(err)}`,
  );
}

const runtimePlugin = runtimeModule.default;
if (!runtimePlugin || typeof runtimePlugin !== "object") {
  fail(
    `${pkgName}: dist/index.js has no usable default export (expected KuzoPluginV2 object).`,
  );
}

const runtimeCaps = Array.isArray(runtimePlugin.capabilities)
  ? runtimePlugin.capabilities
  : [];
const runtimeOpt = Array.isArray(runtimePlugin.optionalCapabilities)
  ? runtimePlugin.optionalCapabilities
  : [];

/**
 * Stable JSON serializer — sorts object keys recursively so capability field
 * order doesn't cause spurious drift. Array order is preserved (it IS
 * semantically meaningful: the canonical declaration order in src/index.ts
 * should match package.json so reviewers can diff line-by-line).
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

const diffs = [];

if (stableStringify(staticCaps) !== stableStringify(runtimeCaps)) {
  diffs.push({
    field: "capabilities",
    static: staticCaps,
    runtime: runtimeCaps,
  });
}

if (stableStringify(staticOpt) !== stableStringify(runtimeOpt)) {
  diffs.push({
    field: "optionalCapabilities",
    static: staticOpt,
    runtime: runtimeOpt,
  });
}

if (diffs.length > 0) {
  console.error(`✗ ${pkgName}: capability manifest drift detected.`);
  for (const d of diffs) {
    console.error(`\n  Field: kuzoPlugin.${d.field}`);
    console.error(`  static  (package.json):`);
    console.error(JSON.stringify(d.static, null, 2));
    console.error(`  runtime (dist/index.js default export):`);
    console.error(JSON.stringify(d.runtime, null, 2));
  }
  console.error(
    `\nFix: align package.json#kuzoPlugin with the runtime manifest exported from src/index.ts (or vice versa). See docs/credentials-spec.md §A.0.1.`,
  );
  process.exit(1);
}

console.log(
  `✓ ${pkgName}: capability manifest parity OK (${runtimeCaps.length} required, ${runtimeOpt.length} optional).`,
);
