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
  {
    ignores: ["**/dist/", "**/node_modules/"],
  },
);
