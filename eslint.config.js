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
  // between ConfigManager construction (boot step 2) and `scrubProcessEnv`
  // (boot step 7). Plugin children are spawned only via
  // `packages/core/src/plugin-process.ts` after scrub completes; the pre-scrub
  // paths (`server.ts` + `loader.ts`) are not allowed to import the module
  // at all. Spec calls for a rule PAIR — `no-restricted-imports` catches the
  // static-import surface, `no-restricted-syntax` is defense-in-depth against
  // namespace-aliased calls (`childProcess.fork(...)`) or `require()` paths.
  {
    files: ["packages/core/src/server.ts", "packages/core/src/loader.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              message:
                "child_process.fork/spawn/exec/execFile/spawnSync/execSync/execFileSync MUST NOT be invoked in pre-scrub paths. Plugin children are spawned only via packages/core/src/plugin-process.ts after scrub completes. See docs/credentials-spec.md §C.1 invariant 5 + §C.9.",
            },
            {
              name: "child_process",
              message:
                "Use 'node:child_process' for built-in modules. (And don't import it from server.ts or loader.ts — see docs/credentials-spec.md §C.9.)",
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
