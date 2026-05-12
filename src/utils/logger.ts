import { createHash } from 'node:crypto';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
export type LogFormat = 'text' | 'json';
export type LogStream = 'stdout' | 'stderr';

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function parseLevel(raw: string | undefined): LogLevel {
  if (!raw) return 'info';
  const lower = raw.toLowerCase();
  if (lower === 'silent' || lower === 'off' || lower === 'none') return 'silent';
  if (lower === 'error') return 'error';
  if (lower === 'warn' || lower === 'warning') return 'warn';
  if (lower === 'debug' || lower === 'trace' || lower === 'verbose') return 'debug';
  return 'info';
}

function parseFormat(raw: string | undefined): LogFormat {
  return raw && raw.toLowerCase() === 'json' ? 'json' : 'text';
}

/** Keys whose values must never be logged, even at debug. */
const SECRET_KEY_RE = /token|password|secret|authorization|api[_-]?key/i;
/** Keys whose values are usually large content blobs (note body, attachment, etc.). */
const BLOB_KEYS = new Set([
  'content',
  'text',
  'body',
  'data',
  'attachment',
  'blob',
  'html',
  'markdown',
]);

const MAX_SCALAR_LEN = 64;

/** Return a redacted shallow copy of `args` safe for debug logging. */
export function redactArgs(args: unknown): unknown {
  if (args === null || args === undefined) return args;
  if (typeof args !== 'object') return truncateScalar(args);
  if (Array.isArray(args)) {
    return `<array len=${args.length}>`;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = '<redacted>';
      continue;
    }
    if (BLOB_KEYS.has(k.toLowerCase())) {
      if (typeof v === 'string') {
        out[k] = `<string len=${v.length}>`;
      } else if (Array.isArray(v)) {
        out[k] = `<array len=${v.length}>`;
      } else {
        out[k] = `<${typeof v}>`;
      }
      continue;
    }
    if (v === null || v === undefined) {
      out[k] = v;
    } else if (typeof v === 'object') {
      out[k] = Array.isArray(v) ? `<array len=${v.length}>` : '<object>';
    } else {
      out[k] = truncateScalar(v);
    }
  }
  return out;
}

function truncateScalar(v: unknown): unknown {
  if (typeof v === 'string' && v.length > MAX_SCALAR_LEN) {
    return v.slice(0, MAX_SCALAR_LEN) + `…(+${v.length - MAX_SCALAR_LEN})`;
  }
  return v;
}

/** Short, non-reversible identifier for a secret — for correlation only. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

interface CreateLoggerOptions {
  stream?: LogStream;
  level?: LogLevel;
  format?: LogFormat;
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const level = opts.level ?? parseLevel(process.env.LOG_LEVEL);
  const format = opts.format ?? parseFormat(process.env.LOG_FORMAT);
  const stream: LogStream = opts.stream ?? 'stderr';
  const threshold = LEVEL_ORDER[level];

  const write = (line: string): void => {
    const target = stream === 'stdout' ? process.stdout : process.stderr;
    target.write(line + '\n');
  };

  const emit = (lvl: Exclude<LogLevel, 'silent'>, event: string, fields?: Record<string, unknown>): void => {
    if (threshold < LEVEL_ORDER[lvl]) return;
    const ts = new Date().toISOString();
    if (format === 'json') {
      const payload: Record<string, unknown> = { ts, level: lvl, event, ...(fields ?? {}) };
      let serialized: string;
      try {
        serialized = JSON.stringify(payload);
      } catch {
        serialized = JSON.stringify({ ts, level: lvl, event, _err: 'unserializable_fields' });
      }
      write(serialized);
    } else {
      write(`${ts} ${lvl.toUpperCase().padEnd(5)} ${event}${formatFieldsText(fields)}`);
    }
  };

  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    debug: (event, fields) => emit('debug', event, fields),
  };
}

export function createLoggerForTransport(transport: 'stdio' | 'http'): Logger {
  return createLogger({ stream: transport === 'stdio' ? 'stderr' : 'stdout' });
}

function formatFieldsText(fields: Record<string, unknown> | undefined): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${formatScalar(v)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function formatScalar(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') {
    if (v.length === 0 || /[\s="]/.test(v)) {
      return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '<unserializable>';
  }
}
