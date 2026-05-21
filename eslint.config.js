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
  {
    files: ["packages/**/*.ts", "scripts/**/*.mjs"],
    ignores: ["packages/core/src/paths.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression:has(CallExpression[callee.name='homedir']):has(Literal[value='.kuzo'])",
          message:
            "Don't inline `homedir() + '.kuzo'`. Import the appropriate helper (kuzoHome, pluginsRoot, consentFilePath, auditFilePath, tufCacheDir, …) from `@kuzo-mcp/core/paths` so KUZO_HOME overrides apply uniformly.",
        },
      ],
    },
  },
  {
    ignores: ["**/dist/", "**/node_modules/"],
  },
);
