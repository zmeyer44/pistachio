/**
 * Structured logging for the runner. Production writes one JSON line per
 * event to stdout/stderr; tests inject `silentLogger`. Nothing content-class
 * (page text, URLs of pages, cookie values) is ever passed to a logger — the
 * call sites log ids, reasons, and hostnames at most (D25).
 */

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function line(level: string, message: string, fields?: Record<string, unknown>): string {
  return JSON.stringify({ level, at: new Date().toISOString(), message, ...(fields ?? {}) });
}

export const consoleLogger: Logger = {
  info: (message, fields) => console.log(line("info", message, fields)),
  warn: (message, fields) => console.warn(line("warn", message, fields)),
  error: (message, fields) => console.error(line("error", message, fields)),
};

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
