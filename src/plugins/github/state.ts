/**
 * Plugin-scoped state for the github plugin.
 *
 * Tool handlers access the initialized `GitHubClient` via `getClient()`. The
 * plugin's `initialize()` sets it exactly once via `setClient()`. This is NOT a
 * cross-process singleton — it's module-local state that's always wiped when
 * the plugin module is re-imported (e.g. in tests).
 */

import type { GitHubClient } from "./client.js";

let _client: GitHubClient | null = null;

export function setClient(client: GitHubClient): void {
  _client = client;
}

export function getClient(): GitHubClient {
  if (!_client) {
    throw new Error(
      "github plugin accessed before initialization. Tool handlers should never run before initialize() completes.",
    );
  }
  return _client;
}

/** Test/shutdown helper — clears the client reference */
export function resetClient(): void {
  _client = null;
}
