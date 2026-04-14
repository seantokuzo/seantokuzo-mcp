/**
 * Structured logger with plugin-scoped prefixes.
 * All output goes to stderr to avoid corrupting the MCP stdio transport.
 */

import chalk from "chalk";
import type { PluginLogger } from "@kuzo-mcp/types";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_COLORS: Record<LogLevel, (text: string) => string> = {
  debug: chalk.gray,
  info: chalk.blue,
  warn: chalk.yellow,
  error: chalk.red,
};

export class KuzoLogger implements PluginLogger {
  private debugMode: boolean;
  private prefix: string;

  constructor(prefix?: string) {
    this.debugMode = process.env["DEBUG"] === "true";
    this.prefix = prefix ?? "kuzo";
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (level === "debug" && !this.debugMode) return;

    const timestamp =
      new Date().toISOString().split("T")[1]?.slice(0, 8) ?? "";
    const color = LEVEL_COLORS[level];
    const ts = chalk.gray(`[${timestamp}]`);
    const lvl = color(`[${level.toUpperCase()}]`);
    const pfx = chalk.cyan(`[${this.prefix}]`);

    process.stderr.write(`${ts} ${lvl} ${pfx} ${message}\n`);

    if (data !== undefined) {
      process.stderr.write(chalk.gray(JSON.stringify(data, null, 2)) + "\n");
    }
  }

  debug(message: string, data?: unknown): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: unknown): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: unknown): void {
    this.log("error", message, data);
  }
}

/** Create a plugin-scoped logger that prefixes all output with the plugin name */
export function createPluginLogger(pluginName: string): PluginLogger {
  return new KuzoLogger(pluginName);
}
