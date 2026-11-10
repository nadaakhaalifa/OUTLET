import { redact } from "./redact.js";

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

export interface LogContext {
  readonly requestId?: string;
  readonly marketId?: string;
}

export interface LoggerOptions {
  readonly level?: Level;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
  readonly context?: LogContext;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(context: LogContext): Logger;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const min = LEVELS[options.level ?? "info"];
  const write = options.write ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const now = options.now ?? (() => new Date());
  const context: LogContext = options.context ?? {};

  const emit = (level: Level, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[level] < min) return;
    const record = {
      ...(redact(fields ?? {}) as Record<string, unknown>),
      level,
      time: now().toISOString(),
      msg: redact(msg),
      ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
      ...(context.marketId !== undefined ? { marketId: context.marketId } : {}),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ level, time: record.time, msg: "[unserialisable log record]" });
    }
    write(line);
  };

  return {
    debug: (m, f) => { emit("debug", m, f); },
    info: (m, f) => { emit("info", m, f); },
    warn: (m, f) => { emit("warn", m, f); },
    error: (m, f) => { emit("error", m, f); },
    child: (c) => createLogger({ ...options, context: { ...context, ...c } }),
  };
}
