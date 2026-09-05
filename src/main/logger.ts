import log from "electron-log/main";
import { app } from "electron";
import { join } from "path";

const SENSITIVE_KEY = /^(authorization|proxy-authorization|license[_-]?key|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key)$/i;

function redactString(value: string): string {
  return value
    .replace(/([?&](?:access_token|refresh_token|token|key|api_key|auth|authorization)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*)[^\r\n,;}]+/gi, "$1[REDACTED]")
    .replace(/((?:license[_-]?key|password|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;}]+/gi, "$1[REDACTED]")
    .replace(/((?:https?|wss?):\/\/)[^/@\s]+@/gi, "$1[REDACTED]@");
}

function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined };
  }
  if (Array.isArray(value)) return value.map((entry) => redactLogValue(entry, seen));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactLogValue(entry, seen);
  }
  return result;
}

/**
 * Initialize electron-log for persistent file logging.
 * Log files are stored in the app's userData/logs directory.
 *
 * Must be called after app.whenReady() since it uses app.getPath().
 */
export function initLogger(): void {
  // Store logs in userData/logs/
  const logDir = join(app.getPath("userData"), "logs");
  log.transports.file.resolvePathFn = () => join(logDir, "main.log");

  // Keep max 5MB per file, rotate up to 3 old files
  log.transports.file.maxSize = 5 * 1024 * 1024;

  // Log level: info and above go to file, all go to console in dev
  log.transports.file.level = "info";
  log.transports.console.level = process.env.NODE_ENV === "development" ? "debug" : "warn";

  // Format: [timestamp] [level] message
  log.transports.file.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}";

  log.hooks.push((message) => ({
    ...message,
    data: message.data.map((value) => redactLogValue(value)),
  }));

  // Override console methods so existing console.log/warn/error
  // statements throughout the codebase are automatically captured.
  log.initialize();

  log.info("=== Application started ===");
  log.info(`Version: ${app.getVersion()}, Platform: ${process.platform} ${process.arch}`);
  log.info(`Electron: ${process.versions.electron}, Node: ${process.versions.node}`);
}

/**
 * Get the directory containing log files.
 */
export function getLogPath(): string {
  return join(app.getPath("userData"), "logs", "main.log");
}

export default log;
