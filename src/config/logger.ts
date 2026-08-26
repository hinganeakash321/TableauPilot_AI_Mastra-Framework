/**
 * Safe logging utility.
 *
 * Central place for application logging that NEVER prints secrets. All values
 * are passed through {@link redact} before being logged. See spec sections 70 / 83.
 */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

/** Keys whose values must always be masked when logged. */
const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|secret|token|password|pat|authorization|bearer|cookie|credential)/i;

/** Patterns for secret-looking values that should be masked even without a key. */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /sk-or-v1-[A-Za-z0-9]{6,}/g, // OpenRouter keys (check before generic sk-)
  /sk-[A-Za-z0-9-_]{6,}/g, // OpenAI/Anthropic-style keys
  /Bearer\s+[A-Za-z0-9._-]{6,}/gi,
];

const REDACTED = "***REDACTED***";

function maskString(value: string): string {
  let out = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Recursively redacts sensitive information from an arbitrary value so it is
 * safe to log or attach to traces.
 */
export function redact<T>(value: T, seen = new WeakSet<object>()): T {
  if (value == null) return value;
  if (typeof value === "string") return maskString(value) as unknown as T;
  if (typeof value !== "object") return value;

  if (seen.has(value as object)) return "[Circular]" as unknown as T;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = REDACTED;
    } else {
      result[key] = redact(val, seen);
    }
  }
  return result as unknown as T;
}

class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = "INFO") {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(meta !== undefined ? { meta: redact(meta) } : {}),
    };
    const line = JSON.stringify(entry);
    if (level === "ERROR" || level === "WARN") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  debug(message: string, meta?: unknown): void {
    this.write("DEBUG", message, meta);
  }
  info(message: string, meta?: unknown): void {
    this.write("INFO", message, meta);
  }
  warn(message: string, meta?: unknown): void {
    this.write("WARN", message, meta);
  }
  error(message: string, meta?: unknown): void {
    this.write("ERROR", message, meta);
  }
}

export const logger = new Logger(
  (process.env.LOG_LEVEL as LogLevel | undefined) ?? "INFO",
);
