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
  {
    ignores: ["**/dist/", "**/node_modules/"],
  },
);
