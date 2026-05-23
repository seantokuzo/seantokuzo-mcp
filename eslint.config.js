import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      // Allow `_`-prefixed args/vars to signal intentional non-use.
      // Matches TypeScript's `noUnusedParameters` convention.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["packages/plugin-*/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@kuzo-mcp/plugin-*", "@kuzo-mcp/plugin-*/**"],
              message:
                "Plugins must not import from other plugins. Use callTool() via PluginContext for cross-plugin communication.",
            },
          ],
        },
      ],
    },
  },
  // Phase 2.6 §E.2: only `packages/core/src/paths.ts` is allowed to compose
  // the default `~/.kuzo` path. Every other site must import the helpers from
  // `@kuzo-mcp/core/paths` so `KUZO_HOME` overrides flow through uniformly.
  //
  // Three selectors cover the realistic drift shapes:
  //   1. `join(homedir(), ".kuzo", …)`                — CallExpression + Literal
  //   2. `homedir() + ".kuzo"` / `homedir() + "/.kuzo"` — BinaryExpression
  //   3. `` `${homedir()}/.kuzo` ``                    — TemplateLiteral
  // Each selector uses `:matches()` to accept either the named-import call
  // shape `homedir()` or the namespace-import shape `os.homedir()` (round-2
  // Correctness advisory).
  {
    files: ["packages/**/*.ts", "scripts/**/*.mjs"],
    ignores: ["packages/core/src/paths.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression:has(CallExpression:matches([callee.name='homedir'], [callee.object.name='os'][callee.property.name='homedir'])):has(Literal[value='.kuzo'])",
          message:
            "Don't inline `join(homedir(), '.kuzo', …)`. Import the appropriate helper (kuzoHome, pluginsRoot, consentFilePath, auditFilePath, tufCacheDir, …) from `@kuzo-mcp/core/paths` so KUZO_HOME overrides apply uniformly.",
        },
        {
          selector:
            "BinaryExpression[operator='+']:has(CallExpression:matches([callee.name='homedir'], [callee.object.name='os'][callee.property.name='homedir'])):has(Literal[value=/\\.kuzo/])",
          message:
            "Don't inline `homedir() + '.kuzo'` (or `homedir() + '/.kuzo'`). Import the appropriate helper from `@kuzo-mcp/core/paths` so KUZO_HOME overrides apply uniformly.",
        },
        {
          selector:
            "TemplateLiteral:has(CallExpression:matches([callee.name='homedir'], [callee.object.name='os'][callee.property.name='homedir'])):has(TemplateElement[value.cooked=/\\.kuzo/])",
          message:
            "Don't inline `` `${homedir()}/.kuzo` `` in a template literal. Import the appropriate helper from `@kuzo-mcp/core/paths` so KUZO_HOME overrides apply uniformly.",
        },
      ],
    },
  },
  // Phase 2.6 §C.1 invariant 5 + §C.9: `child_process` MUST NOT be invoked
  // outside `packages/core/src/plugin-process.ts` — the ONLY file allowed
  // to fork plugin children, and only after the boot-step-7 scrub has
  // completed. The spec scoped this rule to `server.ts` + `loader.ts`;
  // the round-3 Architecture advisory widened the `files:` glob to the
  // whole `packages/core/src/**/*.ts` tree so future code added to any
  // pre-scrub module (manifest-env-names, plugin-resolver, key-provider-
  // choice, audit, consent, credentials/*) is automatically covered.
  // `paths.ts` is also `ignores`-exempted here to preserve the §E.2
  // kuzoHome carve-out — only `paths.ts` may compose `~/.kuzo` from
  // `homedir()`, and the kuzoHome no-restricted-syntax selectors are
  // re-listed below alongside the childProcess selector because flat-
  // config rule merging is last-wins per file.
  //
  // Spec asks for a rule PAIR: `no-restricted-imports` catches the
  // static-import surface, `no-restricted-syntax` is defense-in-depth
  // against namespace-aliased calls (`childProcess.fork(...)`) or
  // `require()` paths.
  {
    files: ["packages/core/src/**/*.ts"],
    ignores: [
      "packages/core/src/plugin-process.ts",
      "packages/core/src/paths.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              message:
                "child_process.fork/spawn/exec/execFile/spawnSync/execSync/execFileSync MUST NOT be invoked outside of packages/core/src/plugin-process.ts (the only allowed spawn site, after the boot-step-7 scrub). Type-only imports (`import type { ChildProcess }`) are permitted. See docs/credentials-spec.md §C.1 invariant 5 + §C.9.",
              allowTypeImports: true,
            },
            {
              name: "child_process",
              message:
                "Use 'node:child_process' for built-in modules — and only inside packages/core/src/plugin-process.ts. Type-only imports are permitted. See docs/credentials-spec.md §C.9.",
              allowTypeImports: true,
            },
          ],
        },
      ],
      // Include the kuzoHome selectors from the §E.2 rule above — flat
      // config merges by rule name (last-wins per file), so a bare
      // child_process selector here would silently drop the kuzoHome
      // checks for server.ts + loader.ts. The two selectors are unrelated
      // (no overlap) and listing both keeps both checks active.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='childProcess']",
          message:
            "child_process methods are banned in pre-scrub paths (defense-in-depth vs. namespace-aliased imports / require). See docs/credentials-spec.md §C.9.",
        },
        {
          selector:
            "CallExpression:has(CallExpression:matches([callee.name='homedir'], [callee.object.name='os'][callee.property.name='homedir'])):has(Literal[value='.kuzo'])",
          message:
            "Don't inline `join(homedir(), '.kuzo', …)`. Import the appropriate helper (kuzoHome, pluginsRoot, consentFilePath, auditFilePath, tufCacheDir, …) from `@kuzo-mcp/core/paths` so KUZO_HOME overrides apply uniformly.",
        },
        {
          selector:
            "BinaryExpression[operator='+']:has(CallExpression:matches([callee.name='homedir'], [callee.object.name='os'][callee.property.name='homedir'])):has(Literal[value=/\\.kuzo/])",
          message:
            "Don't inline `homedir() + '.kuzo'` (or `homedir() + '/.kuzo'`). Import the appropriate helper from `@kuzo-mcp/core/paths` so KUZO_HOME overrides apply uniformly.",
        },
        {
          selector:
            "TemplateLiteral:has(CallExpression:matches([callee.name='homedir'], [callee.object.name='os'][callee.property.name='homedir'])):has(TemplateElement[value.cooked=/\\.kuzo/])",
          message:
            "Don't inline `` `${homedir()}/.kuzo` `` in a template literal. Import the appropriate helper from `@kuzo-mcp/core/paths` so KUZO_HOME overrides apply uniformly.",
        },
      ],
    },
  },
  {
    ignores: ["**/dist/", "**/node_modules/"],
  },
);
