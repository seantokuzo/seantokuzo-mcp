import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "dist/",
      "node_modules/",
      // Pre-refactor code — will be lint-clean when converted to plugins (Phase 2)
      "src/services/",
      "src/cli/",
      "src/mcp/",
      "src/server.ts",
    ],
  },
);
