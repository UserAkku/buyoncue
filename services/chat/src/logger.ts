/**
 * Minimal structured logger. Call sites log IDs and states only. Never pass
 * message text, redemption data, tokens or secrets to it.
 */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const emit = (level: string, msg: string, fields?: Record<string, unknown>) => {
  const line = `${new Date().toISOString()} ${level} ${msg}${fields ? " " + JSON.stringify(fields) : ""}`;
  (level === "info" ? console.log : console.error)(line);
};

export const consoleLogger: Logger = {
  info: (m, f) => emit("info", m, f),
  warn: (m, f) => emit("warn", m, f),
  error: (m, f) => emit("error", m, f),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
