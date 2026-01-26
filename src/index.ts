/**
 * 🚀 Kuzo MCP Main Entry Point
 *
 * This file is the main entry for the package.
 * It exports everything for programmatic usage.
 */

// Export services
export { GitHubService, getGitHubService } from "./services/github.js";

// Export types
export * from "./types/index.js";

// Export utilities
export { getConfig, validateConfig, isConfigured } from "./utils/config.js";
export { logger } from "./utils/logger.js";

// Export CLI UI components (for custom CLIs)
export * from "./cli/ui/index.js";

// Info
console.log(`
╔═══════════════════════════════════════════╗
║           Kuzo MCP v1.0.0                 ║
║                                           ║
║  Usage:                                   ║
║    CLI:     npx kuzo                      ║
║    MCP:     node dist/mcp/server.js       ║
║    Webhook: node dist/server.js           ║
║                                           ║
║  Run 'kuzo --help' for commands           ║
╚═══════════════════════════════════════════╝
`);
