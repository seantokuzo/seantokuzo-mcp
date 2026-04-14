/**
 * Consent management CLI commands.
 *
 * - kuzo consent       — interactive consent review for all plugins
 * - kuzo permissions    — list all current grants
 * - kuzo revoke <name> — revoke consent for a plugin
 * - kuzo audit          — query the structured audit log
 */

import chalk from "chalk";
import { pathToFileURL, fileURLToPath } from "url";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import { ConsentStore } from "../../core/consent.js";
import { AuditLogger, type AuditEvent } from "../../core/audit.js";
import {
  isV2Plugin,
  type Capability,
  type KuzoPlugin,
} from "@kuzo-mcp/types";
import { showSuccess, showWarning, showError, showInfo } from "../ui/display.js";

/** Shared audit logger for CLI consent commands */
function getAuditLogger(): AuditLogger {
  return new AuditLogger();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the compiled plugins directory */
function pluginsDir(): string {
  // CLI runs from dist/cli/commands/ → dist/plugins/
  return resolve(__dirname, "..", "..", "plugins");
}

/**
 * Load a plugin module by name (for manifest inspection, not initialization).
 *
 * TODO(2.5d): Dynamic import executes the module, which is fine for first-party
 * plugins but could run untrusted code for third-party. When third-party plugins
 * ship, switch to a side-effect-free manifest artifact (e.g., generated JSON).
 */
async function loadPluginManifest(name: string): Promise<KuzoPlugin | undefined> {
  const pluginPath = resolve(pluginsDir(), name, "index.js");
  if (!existsSync(pluginPath)) return undefined;
  const pluginUrl = pathToFileURL(pluginPath).href;
  const module = (await import(pluginUrl)) as Record<string, unknown>;
  return module["default"] as KuzoPlugin | undefined;
}

/** All known plugin names (from the plugins directory) */
async function discoverPlugins(): Promise<string[]> {
  const { readdirSync, statSync } = await import("fs");
  const dir = pluginsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((entry) => {
    const full = resolve(dir, entry);
    return statSync(full).isDirectory() && existsSync(resolve(full, "index.js"));
  });
}

/** Format a capability for display */
function formatCapability(cap: Capability): string {
  const kindTag = chalk.cyan(`[${cap.kind.toUpperCase()}]`);
  switch (cap.kind) {
    case "credentials":
      return `${kindTag}  ${chalk.white(cap.env)} (${cap.access} mode)\n            ${chalk.gray(`→ ${cap.reason}`)}`;
    case "network":
      return `${kindTag}     ${chalk.white(cap.domain)}\n            ${chalk.gray(`→ ${cap.reason}`)}`;
    case "filesystem":
      return `${kindTag}  ${chalk.white(cap.path)} (${cap.access})\n            ${chalk.gray(`→ ${cap.reason}`)}`;
    case "cross-plugin":
      return `${kindTag}${chalk.white(cap.target)}\n            ${chalk.gray(`→ ${cap.reason}`)}`;
    case "system":
      return `${kindTag}      ${chalk.white(cap.operation)}${cap.command ? `:${cap.command}` : ""}\n            ${chalk.gray(`→ ${cap.reason}`)}`;
  }
}

/** Format an audit event for display */
function formatAuditEvent(event: AuditEvent): string {
  const ts = chalk.gray(event.timestamp.replace("T", " ").slice(0, 19));
  const outcomeColor = event.outcome === "denied" ? chalk.red : event.outcome === "error" ? chalk.yellow : chalk.green;
  const outcome = outcomeColor(event.outcome.toUpperCase());
  const plugin = chalk.cyan(event.plugin);
  const action = chalk.white(event.action);
  const details = Object.entries(event.details)
    .map(([k, v]) => `${chalk.gray(k)}=${String(v)}`)
    .join(" ");
  return `${ts}  ${outcome}  ${plugin}  ${action}  ${details}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Interactive consent review — walks through each plugin that needs consent.
 */
export async function consentInteractive(): Promise<void> {
  const inquirer = await import("inquirer");
  const store = new ConsentStore();
  const audit = getAuditLogger();
  const pluginNames = await discoverPlugins();

  if (pluginNames.length === 0) {
    showWarning("No plugins found in plugins directory.");
    return;
  }

  let grantedCount = 0;
  let skippedCount = 0;

  for (const name of pluginNames) {
    const plugin = await loadPluginManifest(name);
    if (!plugin) continue;

    if (!isV2Plugin(plugin)) {
      console.log(chalk.gray(`  ${name} — V1 plugin (legacy, skipping consent)`));
      skippedCount++;
      continue;
    }

    // Check if consent is already current
    if (store.hasConsent(name) && !store.isConsentStale(plugin)) {
      console.log(chalk.green(`  ✓ ${name} — consent already granted`));
      grantedCount++;
      continue;
    }

    const stale = store.hasConsent(name);
    if (stale) {
      showWarning(`Plugin "${name}" has changed since last consent — re-review required.`);
    }

    // Display plugin info
    console.log();
    console.log(chalk.bold(`┌─ Plugin: ${name} v${plugin.version} ${"─".repeat(Math.max(0, 40 - name.length))}`));
    console.log(chalk.gray(`│  "${plugin.description}"`));
    console.log(`│`);

    // Required capabilities
    if (plugin.capabilities.length > 0) {
      console.log(`│  ${chalk.bold("Required capabilities:")}`);
      for (const cap of plugin.capabilities) {
        const lines = formatCapability(cap).split("\n");
        for (const line of lines) {
          console.log(`│    ${line}`);
        }
      }
    }

    // Optional capabilities
    if (plugin.optionalCapabilities && plugin.optionalCapabilities.length > 0) {
      console.log(`│`);
      console.log(`│  ${chalk.bold("Optional capabilities:")}`);
      for (const cap of plugin.optionalCapabilities) {
        const lines = formatCapability(cap).split("\n");
        for (const line of lines) {
          console.log(`│    ${line}`);
        }
      }
    }

    console.log(`└${"─".repeat(56)}`);
    console.log();

    // Prompt
    const { decision } = await inquirer.default.prompt<{ decision: string }>([
      {
        type: "list",
        name: "decision",
        message: `Grant consent for "${name}"?`,
        choices: [
          { name: "Yes — grant all capabilities", value: "yes" },
          { name: "No — skip this plugin", value: "no" },
        ],
      },
    ]);

    if (decision === "yes") {
      const allCaps = [...plugin.capabilities, ...(plugin.optionalCapabilities ?? [])];
      store.grantConsent(plugin, allCaps);
      audit.log({
        plugin: name,
        action: "consent.granted",
        outcome: "allowed",
        details: { version: plugin.version, capabilityCount: allCaps.length },
      });
      showSuccess(`Consent granted for "${name}".`);
      grantedCount++;
    } else {
      console.log(chalk.gray(`  Skipped "${name}".`));
      skippedCount++;
    }
  }

  console.log();
  showInfo(
    `Consent review complete: ${grantedCount} granted, ${skippedCount} skipped.`,
  );
}

/**
 * List all current permission grants.
 */
export async function permissionsInteractive(): Promise<void> {
  const store = new ConsentStore();
  const all = store.listAll();
  const entries = Object.entries(all);

  if (entries.length === 0) {
    showInfo("No consent records found. Run `kuzo consent` to review plugins.");
    return;
  }

  for (const [name, record] of entries) {
    console.log();
    console.log(
      chalk.bold(`${name}`) +
        chalk.gray(` v${record.pluginVersion} — granted ${new Date(record.grantedAt).toLocaleDateString()}`),
    );

    for (const cap of record.granted) {
      console.log(`  ${formatCapability(cap).split("\n").join("\n  ")}`);
    }

    if (record.denied.length > 0) {
      console.log(chalk.red(`  Denied:`));
      for (const cap of record.denied) {
        console.log(`    ${formatCapability(cap).split("\n").join("\n    ")}`);
      }
    }
  }
  console.log();
}

/**
 * Revoke consent for a plugin.
 */
export async function revokeInteractive(pluginName?: string): Promise<void> {
  const inquirer = await import("inquirer");
  const store = new ConsentStore();

  if (!pluginName) {
    const all = store.listAll();
    const names = Object.keys(all);
    if (names.length === 0) {
      showInfo("No consent records to revoke.");
      return;
    }

    const { selected } = await inquirer.default.prompt<{ selected: string }>([
      {
        type: "list",
        name: "selected",
        message: "Which plugin's consent should be revoked?",
        choices: names,
      },
    ]);
    pluginName = selected;
  }

  const { confirm } = await inquirer.default.prompt<{ confirm: boolean }>([
    {
      type: "confirm",
      name: "confirm",
      message: `Revoke ALL consent for "${pluginName}"? The plugin will not load until re-consented.`,
      default: false,
    },
  ]);

  if (confirm) {
    const revoked = store.revokeConsent(pluginName);
    if (revoked) {
      const audit = getAuditLogger();
      audit.log({
        plugin: pluginName,
        action: "consent.revoked",
        outcome: "allowed",
        details: { revokedBy: "cli" },
      });
      showSuccess(`Consent revoked for "${pluginName}".`);
    } else {
      showWarning(`No consent record found for "${pluginName}".`);
    }
  }
}

/**
 * Query and display the audit log.
 */
export async function auditInteractive(sinceArg?: string): Promise<void> {
  const auditLogger = new AuditLogger();
  let since: Date | undefined;

  if (sinceArg) {
    since = parseSinceArg(sinceArg);
    if (!since) {
      showError(`Invalid --since value: "${sinceArg}". Use formats like "7d", "24h", "2026-04-01".`);
      return;
    }
  }

  const events = auditLogger.query({ since });

  if (events.length === 0) {
    showInfo(since ? "No audit events in the specified time range." : "No audit events recorded yet.");
    return;
  }

  console.log(chalk.bold(`\nAudit log (${events.length} events):\n`));
  for (const event of events) {
    console.log(formatAuditEvent(event));
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Since parser
// ---------------------------------------------------------------------------

function parseSinceArg(arg: string): Date | undefined {
  // Relative: "7d", "24h", "30m"
  const relative = /^(\d+)([dhm])$/.exec(arg);
  if (relative) {
    const amount = parseInt(relative[1]!, 10);
    const unit = relative[2]!;
    const ms =
      unit === "d" ? amount * 86400000 :
      unit === "h" ? amount * 3600000 :
      amount * 60000;
    return new Date(Date.now() - ms);
  }

  // Absolute: ISO date string
  const parsed = new Date(arg);
  if (!isNaN(parsed.getTime())) return parsed;

  return undefined;
}
