/**
 * CLI bootstrap — loads `.env` as a side-effect before any other CLI import.
 *
 * Imported as the FIRST statement in `src/cli/index.ts`. ESM evaluates
 * dependencies depth-first in source order, so this module's body runs
 * before any sibling import's body — making env vars available by the time
 * the rest of the CLI loads.
 */

import { config as dotenvConfig } from "dotenv";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Try multiple locations for .env file (mirrors src/core/config.ts logic)
const possibleEnvPaths = [
  resolve(__dirname, "../../.env"), // dist/cli -> project root
  resolve(__dirname, "../../../.env"), // one more level up
  resolve(process.cwd(), ".env"), // current working directory
];

const envPath = possibleEnvPaths.find((p) => existsSync(p));
if (envPath) {
  dotenvConfig({ path: envPath });
} else {
  // Fallback to default dotenv behavior
  dotenvConfig();
}
