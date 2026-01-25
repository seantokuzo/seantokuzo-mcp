/**
 * 📝 Logger utility with style
 */

import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error" | "success";

const levelColors: Record<LogLevel, (text: string) => string> = {
  debug: chalk.gray,
  info: chalk.blue,
  warn: chalk.yellow,
  error: chalk.red,
  success: chalk.green,
};

const levelIcons: Record<LogLevel, string> = {
  debug: "🔍",
  info: "ℹ️",
  warn: "⚠️",
  error: "❌",
  success: "✅",
};

class Logger {
  private debugMode: boolean;

  constructor() {
    this.debugMode = process.env["DEBUG"] === "true";
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (level === "debug" && !this.debugMode) return;

    const color = levelColors[level];
    const icon = levelIcons[level];
    const timestamp = new Date().toISOString().split("T")[1]?.slice(0, 8) || "";

    const prefix = chalk.gray(`[${timestamp}]`);
    const levelStr = color(`[${level.toUpperCase()}]`);

    console.log(`${prefix} ${levelStr} ${icon} ${message}`);

    if (data) {
      console.log(chalk.gray(JSON.stringify(data, null, 2)));
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

  success(message: string, data?: unknown): void {
    this.log("success", message, data);
  }

  // Raw output without formatting (for CLI display)
  raw(message: string): void {
    console.log(message);
  }

  // Newline
  newline(): void {
    console.log();
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }
}

export const logger = new Logger();
export default logger;
