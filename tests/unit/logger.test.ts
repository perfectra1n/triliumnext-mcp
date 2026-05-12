import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createLogger,
  createLoggerForTransport,
  fingerprint,
  redactArgs,
} from '../../src/utils/logger.js';

function captureStream(stream: 'stdout' | 'stderr'): {
  lines: string[];
  restore: () => void;
} {
  const lines: string[] = [];
  const target = stream === 'stdout' ? process.stdout : process.stderr;
  const spy = vi.spyOn(target, 'write').mockImplementation((chunk: unknown) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
    // Strip the trailing newline the logger always appends.
    lines.push(text.endsWith('\n') ? text.slice(0, -1) : text);
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('redactArgs', () => {
  it('returns primitives unchanged when short', () => {
    expect(redactArgs(42)).toBe(42);
    expect(redactArgs('hello')).toBe('hello');
    expect(redactArgs(true)).toBe(true);
  });

  it('passes through null and undefined', () => {
    expect(redactArgs(null)).toBeNull();
    expect(redactArgs(undefined)).toBeUndefined();
  });

  it('truncates long string scalars at top level', () => {
    const long = 'x'.repeat(200);
    const out = redactArgs(long);
    expect(typeof out).toBe('string');
    expect((out as string).startsWith('x'.repeat(64))).toBe(true);
    expect((out as string)).toContain('…(+136)');
  });

  it('summarizes a top-level array', () => {
    expect(redactArgs([1, 2, 3, 4])).toBe('<array len=4>');
  });

  it('redacts secret-named fields regardless of value', () => {
    const out = redactArgs({
      token: 'abc',
      password: 'p',
      secret: 's',
      authorization: 'Bearer xyz',
      apiKey: 'k1',
      api_key: 'k2',
      noteId: 'visible',
    }) as Record<string, unknown>;
    expect(out.token).toBe('<redacted>');
    expect(out.password).toBe('<redacted>');
    expect(out.secret).toBe('<redacted>');
    expect(out.authorization).toBe('<redacted>');
    expect(out.apiKey).toBe('<redacted>');
    expect(out.api_key).toBe('<redacted>');
    expect(out.noteId).toBe('visible');
  });

  it('summarizes content-blob keys by shape, not value', () => {
    const out = redactArgs({
      content: 'A'.repeat(5000),
      text: 'short',
      body: [1, 2, 3],
      data: { nested: true },
      attachment: 'x'.repeat(10),
      blob: 'y',
      html: '<p>hi</p>',
      markdown: '# title',
    }) as Record<string, unknown>;
    expect(out.content).toBe('<string len=5000>');
    expect(out.text).toBe('<string len=5>');
    expect(out.body).toBe('<array len=3>');
    expect(out.data).toBe('<object>');
    expect(out.attachment).toBe('<string len=10>');
    expect(out.blob).toBe('<string len=1>');
    expect(out.html).toBe('<string len=9>');
    expect(out.markdown).toBe('<string len=7>');
  });

  it('truncates long non-blob string scalars to 64 chars', () => {
    const out = redactArgs({ title: 'x'.repeat(100) }) as Record<string, unknown>;
    expect(typeof out.title).toBe('string');
    expect((out.title as string)).toMatch(/^x{64}…\(\+36\)$/);
  });

  it('replaces nested objects and arrays with shape descriptors (no deep traversal)', () => {
    const out = redactArgs({
      nested: { token: 'leak-me' },
      list: [1, 2, 3],
    }) as Record<string, unknown>;
    expect(out.nested).toBe('<object>');
    expect(out.list).toBe('<array len=3>');
    // Defensive: ensure 'leak-me' never appears anywhere in the serialized form.
    expect(JSON.stringify(out)).not.toContain('leak-me');
  });

  it('preserves null/undefined values at field level', () => {
    const out = redactArgs({ a: null, b: undefined, c: 1 }) as Record<string, unknown>;
    expect(out.a).toBeNull();
    expect(out.b).toBeUndefined();
    expect(out.c).toBe(1);
  });

  it('matches secret keys case-insensitively', () => {
    const out = redactArgs({ TOKEN: 'x', PassWord: 'y' }) as Record<string, unknown>;
    expect(out.TOKEN).toBe('<redacted>');
    expect(out.PassWord).toBe('<redacted>');
  });
});

describe('fingerprint', () => {
  it('produces an 8-char hex string', () => {
    const fp = fingerprint('hello');
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic', () => {
    expect(fingerprint('same')).toBe(fingerprint('same'));
  });

  it('differs for different inputs', () => {
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });
});

describe('createLogger — level thresholds', () => {
  let cap: { lines: string[]; restore: () => void };
  beforeEach(() => {
    cap = captureStream('stderr');
  });
  afterEach(() => cap.restore());

  it('at info level, drops debug and emits info+', () => {
    const log = createLogger({ level: 'info', format: 'text' });
    log.debug('hidden', {});
    log.info('shown', {});
    log.warn('also', {});
    log.error('also2', {});
    expect(cap.lines).toHaveLength(3);
    expect(cap.lines[0]).toContain('shown');
    expect(cap.lines[1]).toContain('also');
    expect(cap.lines[2]).toContain('also2');
  });

  it('at debug level, emits everything', () => {
    const log = createLogger({ level: 'debug', format: 'text' });
    log.debug('d', {});
    log.info('i', {});
    expect(cap.lines).toHaveLength(2);
  });

  it('at silent level, emits nothing', () => {
    const log = createLogger({ level: 'silent', format: 'text' });
    log.error('still hidden', {});
    log.info('still hidden', {});
    expect(cap.lines).toHaveLength(0);
  });

  it('at warn level, drops info', () => {
    const log = createLogger({ level: 'warn', format: 'text' });
    log.info('hidden', {});
    log.warn('shown', {});
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toContain('shown');
  });
});

describe('createLogger — text format', () => {
  let cap: { lines: string[]; restore: () => void };
  beforeEach(() => {
    cap = captureStream('stderr');
  });
  afterEach(() => cap.restore());

  it('produces "<ISO ts> LEVEL event k=v" lines', () => {
    const log = createLogger({ level: 'info', format: 'text' });
    log.info('tool_call', { session: 'abc', tool: 'search_notes', duration_ms: 42, ok: true });
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO  tool_call session=abc tool=search_notes duration_ms=42 ok=true$/
    );
  });

  it('quotes values that contain whitespace or =', () => {
    const log = createLogger({ level: 'info', format: 'text' });
    log.info('evt', { msg: 'hello world', x: 'k=v' });
    expect(cap.lines[0]).toContain('msg="hello world"');
    expect(cap.lines[0]).toContain('x="k=v"');
  });

  it('drops undefined fields', () => {
    const log = createLogger({ level: 'info', format: 'text' });
    log.info('evt', { a: 1, b: undefined, c: 3 });
    expect(cap.lines[0]).toMatch(/a=1 c=3$/);
    expect(cap.lines[0]).not.toContain('b=');
  });

  it('emits the event even without fields', () => {
    const log = createLogger({ level: 'info', format: 'text' });
    log.info('startup', {});
    expect(cap.lines[0]).toMatch(/INFO  startup$/);
  });
});

describe('createLogger — json format', () => {
  let cap: { lines: string[]; restore: () => void };
  beforeEach(() => {
    cap = captureStream('stderr');
  });
  afterEach(() => cap.restore());

  it('emits one parseable JSON object per call', () => {
    const log = createLogger({ level: 'info', format: 'json' });
    log.info('tool_call', { session: 'abc', tool: 'search_notes', duration_ms: 42, ok: true });
    log.warn('url_rejected', { reason: 'private-ip' });
    expect(cap.lines).toHaveLength(2);
    const a = JSON.parse(cap.lines[0]);
    const b = JSON.parse(cap.lines[1]);
    expect(a).toMatchObject({ level: 'info', event: 'tool_call', session: 'abc', tool: 'search_notes' });
    expect(b).toMatchObject({ level: 'warn', event: 'url_rejected', reason: 'private-ip' });
    expect(typeof a.ts).toBe('string');
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not throw on unserializable values; falls back to error marker', () => {
    const log = createLogger({ level: 'info', format: 'json' });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log.info('evt', { circular })).not.toThrow();
    expect(cap.lines).toHaveLength(1);
    const parsed = JSON.parse(cap.lines[0]);
    expect(parsed.event).toBe('evt');
    expect(parsed._err).toBe('unserializable_fields');
  });
});

describe('createLogger — stream selection', () => {
  it('writes to stdout when stream=stdout', () => {
    const stdoutCap = captureStream('stdout');
    const stderrCap = captureStream('stderr');
    try {
      const log = createLogger({ stream: 'stdout', level: 'info', format: 'text' });
      log.info('evt', {});
      expect(stdoutCap.lines).toHaveLength(1);
      expect(stderrCap.lines).toHaveLength(0);
    } finally {
      stdoutCap.restore();
      stderrCap.restore();
    }
  });

  it('writes to stderr when stream=stderr (default)', () => {
    const stdoutCap = captureStream('stdout');
    const stderrCap = captureStream('stderr');
    try {
      const log = createLogger({ level: 'info', format: 'text' });
      log.info('evt', {});
      expect(stdoutCap.lines).toHaveLength(0);
      expect(stderrCap.lines).toHaveLength(1);
    } finally {
      stdoutCap.restore();
      stderrCap.restore();
    }
  });
});

describe('createLoggerForTransport', () => {
  it('stdio routes to stderr (stdout is reserved for JSON-RPC)', () => {
    const stdoutCap = captureStream('stdout');
    const stderrCap = captureStream('stderr');
    try {
      const log = createLoggerForTransport('stdio');
      log.info('server_started', { transport: 'stdio' });
      expect(stdoutCap.lines).toHaveLength(0);
      expect(stderrCap.lines).toHaveLength(1);
    } finally {
      stdoutCap.restore();
      stderrCap.restore();
    }
  });

  it('http routes to stdout', () => {
    const stdoutCap = captureStream('stdout');
    const stderrCap = captureStream('stderr');
    try {
      const log = createLoggerForTransport('http');
      log.info('server_started', { transport: 'http' });
      expect(stdoutCap.lines).toHaveLength(1);
      expect(stderrCap.lines).toHaveLength(0);
    } finally {
      stdoutCap.restore();
      stderrCap.restore();
    }
  });
});

describe('createLogger — env-driven defaults', () => {
  const originalLevel = process.env.LOG_LEVEL;
  const originalFormat = process.env.LOG_FORMAT;

  afterEach(() => {
    if (originalLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLevel;
    if (originalFormat === undefined) delete process.env.LOG_FORMAT;
    else process.env.LOG_FORMAT = originalFormat;
  });

  it('reads LOG_LEVEL when no explicit level is passed', () => {
    process.env.LOG_LEVEL = 'silent';
    const cap = captureStream('stderr');
    try {
      const log = createLogger({ format: 'text' });
      log.error('hidden', {});
      expect(cap.lines).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  it('reads LOG_FORMAT=json when no explicit format is passed', () => {
    process.env.LOG_FORMAT = 'json';
    const cap = captureStream('stderr');
    try {
      const log = createLogger({ level: 'info' });
      log.info('evt', { k: 'v' });
      expect(cap.lines).toHaveLength(1);
      expect(() => JSON.parse(cap.lines[0])).not.toThrow();
    } finally {
      cap.restore();
    }
  });

  it('falls back to info+text on unknown env values', () => {
    process.env.LOG_LEVEL = 'banana';
    process.env.LOG_FORMAT = 'yaml';
    const cap = captureStream('stderr');
    try {
      const log = createLogger();
      log.debug('hidden', {});
      log.info('shown', {});
      expect(cap.lines).toHaveLength(1);
      expect(cap.lines[0]).toMatch(/INFO  shown$/);
    } finally {
      cap.restore();
    }
  });
});
