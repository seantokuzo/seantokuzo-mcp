/**
 * `kuzo plugins list` — print the installed-plugins registry.
 *
 * Read-only per spec §D.6, so no lock acquisition. `--json` emits the raw
 * PluginsIndex for machine consumers; default renders a table for humans.
 *
 * `--verify` is deferred to D.3's standalone `kuzo plugins verify <name>`
 * command — same code path, exposing it twice is churn.
 */

import chalk from "chalk";

import { readIndex, type PluginsIndex } from "./state.js";

export interface ListOptions {
  json?: boolean;
}

export function runList(options: ListOptions): void {
  const index = readIndex();

  if (options.json) {
    console.log(JSON.stringify(index, null, 2));
    return;
  }

  const names = Object.keys(index.plugins).sort();
  if (names.length === 0) {
    console.log(
      chalk.gray(
        "No plugins installed yet. Try: kuzo plugins install <name>",
      ),
    );
    return;
  }

  printTable(index, names);
}

// ---------------------------------------------------------------------------
// Table rendering (hand-built — no table library dep needed for 5 columns)
// ---------------------------------------------------------------------------

const HEADERS = ["Name", "Version", "Source", "Integrity", "Installed"] as const;

function printTable(index: PluginsIndex, names: string[]): void {
  const rows = names.map((name) => {
    const entry = index.plugins[name]!;
    return [
      name,
      entry.currentVersion,
      entry.source,
      shortIntegrity(entry.integrity),
      shortDate(entry.installedAt),
    ];
  });

  const widths = HEADERS.map((h, colIdx) =>
    Math.max(h.length, ...rows.map((r) => r[colIdx]!.length)),
  );

  const header = HEADERS.map((h, i) => chalk.bold(h.padEnd(widths[i]!))).join(
    "  ",
  );
  const divider = widths.map((w) => "─".repeat(w)).join("  ");

  console.log("\n" + header);
  console.log(chalk.gray(divider));
  for (const row of rows) {
    // Pad BEFORE coloring — chalk's ANSI escape codes count toward .length,
    // so padding a colored string pads against the wrong visible width and
    // misaligns columns on a TTY. The header path already does this.
    const line = row
      .map((cell, i) => colorForColumn(i, cell.padEnd(widths[i]!)))
      .join("  ");
    console.log(line);
  }
  console.log(
    chalk.gray(`\n${String(names.length)} plugin(s) installed.`),
  );
}

function colorForColumn(colIdx: number, cell: string): string {
  switch (colIdx) {
    case 0:
      return chalk.cyan(cell);
    case 2:
      return cell === "first-party" ? chalk.green(cell) : chalk.yellow(cell);
    case 3:
      return chalk.gray(cell);
    default:
      return cell;
  }
}

/** `sha512-abcd…` → `sha512-abcd…` truncated to 20 visible chars. Empty → "—". */
function shortIntegrity(integrity: string): string {
  if (!integrity) return "—";
  return integrity.length > 20 ? integrity.slice(0, 20) + "…" : integrity;
}

/** ISO 8601 → `YYYY-MM-DD`. Unparseable → raw string. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}
