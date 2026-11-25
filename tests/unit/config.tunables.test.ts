import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, TUNABLE_DEFAULTS, ConfigError, type Config } from '../../src/config.js';
import {
  DEFAULT_BUSY_PROBE_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
} from '../../src/client/trilium.js';
import { BINARY_RESOURCE_MAX_BYTES } from '../../src/tools/attachments.js';
import { MAX_EXPORT_BYTES } from '../../src/tools/system.js';
import { CONTENT_CHAR_CAP } from '../../src/tools/contentLimits.js';
import {
  DEFAULT_NOTE_IMAGE_MAX_BYTES,
  DEFAULT_NOTE_IMAGES_TOTAL_MAX_BYTES,
  DEFAULT_CONTENT_MAX_CHARS_LIMIT,
  DEFAULT_MAX_PATHS,
  DEFAULT_MAX_BACKLINKS,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_HISTORY_MAX_LIMIT,
  registerNoteTools,
} from '../../src/tools/notes.js';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  FAST_FIRST_MIN_RESULTS,
  MAX_PREVIEW_RESULTS,
  FETCH_CONCURRENCY,
  MAX_TREE_NOTES,
  registerSearchTools,
} from '../../src/tools/search.js';
import {
  MAX_FUZZY_TERMS,
  FUZZY_RECALL_MULTIPLIER,
  FUZZY_RECALL_CAP,
  resolveFuzzyLimit,
  extractFuzzyTerms,
} from '../../src/tools/fuzzySearch.js';
import {
  DEFAULT_SESSION_IDLE_TTL_MS,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SSE_KEEPALIVE_INTERVAL_MS,
  DEFAULT_TRILIUM_VALIDATE_TIMEOUT_MS,
} from '../../src/http/server.js';
import { DEFAULT_JWT_CLOCK_TOLERANCE_SEC } from '../../src/http/jwtAuth.js';
import { configureTools } from '../../src/server.js';
import { registerAttachmentTools } from '../../src/tools/attachments.js';
import { registerSystemTools } from '../../src/tools/system.js';

type Kind = 'size' | 'duration' | 'int';

/** [Config field, env var, CLI flag, kind, a valid raw value, its parsed value] */
const SETTINGS: Array<[keyof Config, string, string, Kind, string, number]> = [
  [
    'busyProbeTimeoutMs',
    'TRILIUM_BUSY_PROBE_TIMEOUT',
    '--busy-probe-timeout',
    'duration',
    '2s',
    2000,
  ],
  ['maxRetries', 'TRILIUM_MAX_RETRIES', '--max-retries', 'int', '0', 0],
  ['retryDelayMs', 'TRILIUM_RETRY_DELAY', '--retry-delay', 'duration', '1s', 1000],
  [
    'maxResponseBytes',
    'TRILIUM_MAX_RESPONSE_BYTES',
    '--max-response-bytes',
    'size',
    '32mb',
    32 * 1024 * 1024,
  ],
  [
    'maxInlineAttachmentBytes',
    'TRILIUM_MAX_INLINE_ATTACHMENT_BYTES',
    '--max-inline-attachment-bytes',
    'size',
    '2mb',
    2 * 1024 * 1024,
  ],
  [
    'maxNoteImageBytes',
    'TRILIUM_MAX_NOTE_IMAGE_BYTES',
    '--max-note-image-bytes',
    'size',
    '512kb',
    512 * 1024,
  ],
  [
    'maxNoteImagesTotalBytes',
    'TRILIUM_MAX_NOTE_IMAGES_TOTAL_BYTES',
    '--max-note-images-total-bytes',
    'size',
    '2mb',
    2 * 1024 * 1024,
  ],
  [
    'maxExportBytes',
    'TRILIUM_MAX_EXPORT_BYTES',
    '--max-export-bytes',
    'size',
    '1gb',
    1024 * 1024 * 1024,
  ],
  ['contentCharCap', 'TRILIUM_CONTENT_CHAR_CAP', '--content-char-cap', 'int', '20000', 20000],
  [
    'contentMaxCharsLimit',
    'TRILIUM_CONTENT_MAX_CHARS_LIMIT',
    '--content-max-chars-limit',
    'int',
    '100000',
    100000,
  ],
  [
    'contentFetchTimeoutMs',
    'TRILIUM_CONTENT_FETCH_TIMEOUT',
    '--content-fetch-timeout',
    'duration',
    '2m',
    120_000,
  ],
  [
    'progressIntervalMs',
    'TRILIUM_PROGRESS_INTERVAL',
    '--progress-interval',
    'duration',
    '5s',
    5000,
  ],
  ['defaultSearchLimit', 'TRILIUM_DEFAULT_SEARCH_LIMIT', '--default-search-limit', 'int', '25', 25],
  ['maxSearchLimit', 'TRILIUM_MAX_SEARCH_LIMIT', '--max-search-limit', 'int', '500', 500],
  [
    'searchFastMinResults',
    'TRILIUM_SEARCH_FAST_MIN_RESULTS',
    '--search-fast-min-results',
    'int',
    '3',
    3,
  ],
  [
    'searchPreviewMaxResults',
    'TRILIUM_SEARCH_PREVIEW_MAX_RESULTS',
    '--search-preview-max-results',
    'int',
    '0',
    0,
  ],
  ['fetchConcurrency', 'TRILIUM_FETCH_CONCURRENCY', '--fetch-concurrency', 'int', '2', 2],
  ['treeMaxNotes', 'TRILIUM_TREE_MAX_NOTES', '--tree-max-notes', 'int', '50', 50],
  ['fuzzyMaxTerms', 'TRILIUM_FUZZY_MAX_TERMS', '--fuzzy-max-terms', 'int', '4', 4],
  [
    'fuzzyRecallMultiplier',
    'TRILIUM_FUZZY_RECALL_MULTIPLIER',
    '--fuzzy-recall-multiplier',
    'int',
    '2',
    2,
  ],
  ['fuzzyRecallCap', 'TRILIUM_FUZZY_RECALL_CAP', '--fuzzy-recall-cap', 'int', '100', 100],
  ['noteMaxPaths', 'TRILIUM_NOTE_MAX_PATHS', '--note-max-paths', 'int', '3', 3],
  ['noteMaxBacklinks', 'TRILIUM_NOTE_MAX_BACKLINKS', '--note-max-backlinks', 'int', '10', 10],
  ['historyLimit', 'TRILIUM_HISTORY_LIMIT', '--history-limit', 'int', '20', 20],
  ['historyMaxLimit', 'TRILIUM_HISTORY_MAX_LIMIT', '--history-max-limit', 'int', '200', 200],
  ['sseKeepaliveMs', 'TRILIUM_SSE_KEEPALIVE', '--sse-keepalive', 'duration', '15s', 15_000],
  ['sessionIdleTtlMs', 'TRILIUM_SESSION_IDLE_TTL', '--session-idle-ttl', 'duration', '5m', 300_000],
  [
    'sessionSweepIntervalMs',
    'TRILIUM_SESSION_SWEEP_INTERVAL',
    '--session-sweep-interval',
    'duration',
    '10s',
    10_000,
  ],
  ['maxSessions', 'TRILIUM_MAX_SESSIONS', '--max-sessions', 'int', '50', 50],
  [
    'triliumValidateTimeoutMs',
    'TRILIUM_VALIDATE_TIMEOUT',
    '--validate-timeout',
    'duration',
    '3s',
    3000,
  ],
  ['jwtClockToleranceSec', 'TRILIUM_JWT_CLOCK_TOLERANCE', '--jwt-clock-tolerance', 'int', '0', 0],
];

const INVALID: Record<Kind, string> = { size: 'lots', duration: 'soon', int: '2.5' };

describe('numeric tunables', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('TRILIUM_')) delete process.env[key];
    }
    process.env.TRILIUM_TOKEN = 'token';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults to the documented values', () => {
    const config = loadConfig([])!;
    for (const [field, value] of Object.entries(TUNABLE_DEFAULTS)) {
      expect(config[field as keyof Config], field).toBe(value);
    }
    // Derived from the idle TTL by the HTTP server when unset.
    expect(config.sessionSweepIntervalMs).toBeUndefined();
  });

  it("keeps config defaults identical to each module's own default", () => {
    expect(TUNABLE_DEFAULTS).toMatchObject({
      busyProbeTimeoutMs: DEFAULT_BUSY_PROBE_TIMEOUT_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
      retryDelayMs: DEFAULT_RETRY_DELAY_MS,
      maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      maxInlineAttachmentBytes: BINARY_RESOURCE_MAX_BYTES,
      maxNoteImageBytes: DEFAULT_NOTE_IMAGE_MAX_BYTES,
      maxNoteImagesTotalBytes: DEFAULT_NOTE_IMAGES_TOTAL_MAX_BYTES,
      maxExportBytes: MAX_EXPORT_BYTES,
      contentCharCap: CONTENT_CHAR_CAP,
      contentMaxCharsLimit: DEFAULT_CONTENT_MAX_CHARS_LIMIT,
      defaultSearchLimit: DEFAULT_SEARCH_LIMIT,
      maxSearchLimit: MAX_SEARCH_LIMIT,
      searchFastMinResults: FAST_FIRST_MIN_RESULTS,
      searchPreviewMaxResults: MAX_PREVIEW_RESULTS,
      fetchConcurrency: FETCH_CONCURRENCY,
      treeMaxNotes: MAX_TREE_NOTES,
      fuzzyMaxTerms: MAX_FUZZY_TERMS,
      fuzzyRecallMultiplier: FUZZY_RECALL_MULTIPLIER,
      fuzzyRecallCap: FUZZY_RECALL_CAP,
      noteMaxPaths: DEFAULT_MAX_PATHS,
      noteMaxBacklinks: DEFAULT_MAX_BACKLINKS,
      historyLimit: DEFAULT_HISTORY_LIMIT,
      historyMaxLimit: DEFAULT_HISTORY_MAX_LIMIT,
      sseKeepaliveMs: DEFAULT_SSE_KEEPALIVE_INTERVAL_MS,
      sessionIdleTtlMs: DEFAULT_SESSION_IDLE_TTL_MS,
      maxSessions: DEFAULT_MAX_SESSIONS,
      triliumValidateTimeoutMs: DEFAULT_TRILIUM_VALIDATE_TIMEOUT_MS,
      jwtClockToleranceSec: DEFAULT_JWT_CLOCK_TOLERANCE_SEC,
    });
  });

  it.each(SETTINGS)('%s reads %s', (field, env, _flag, _kind, raw, parsed) => {
    process.env[env] = raw;
    expect(loadConfig([])![field]).toBe(parsed);
  });

  it.each(SETTINGS)('%s: %s is overridden by %s', (field, env, flag, kind, raw, parsed) => {
    // Any other valid value in the environment; the CLI must win.
    process.env[env] = kind === 'size' ? '7' : kind === 'duration' ? '7ms' : '7';
    expect(loadConfig([flag, raw])![field]).toBe(parsed);
  });

  it.each(SETTINGS)('%s: an invalid %s %s is rejected', (_field, _env, flag, kind) => {
    expect(() => loadConfig([flag, INVALID[kind]])).toThrow(ConfigError);
    expect(() => loadConfig([flag])).toThrow(/requires a value/);
  });

  it('falls back to the default for an invalid size/duration env value, like its neighbours', () => {
    process.env.TRILIUM_MAX_RESPONSE_BYTES = 'lots';
    process.env.TRILIUM_SSE_KEEPALIVE = 'soon';
    const config = loadConfig([])!;
    expect(config.maxResponseBytes).toBe(TUNABLE_DEFAULTS.maxResponseBytes);
    expect(config.sseKeepaliveMs).toBe(TUNABLE_DEFAULTS.sseKeepaliveMs);
  });

  it.each(['abc', '-1', '2.5', ' '])('rejects an invalid integer env value %j', (raw) => {
    process.env.TRILIUM_MAX_SESSIONS = raw;
    // Whitespace is non-empty, so it is rejected rather than silently becoming 0.
    expect(() => loadConfig([])).toThrow(/TRILIUM_MAX_SESSIONS/);
  });

  it('enforces integer minimums', () => {
    expect(() => loadConfig(['--max-sessions', '0'])).toThrow(/>= 1/);
    expect(() => loadConfig(['--default-search-limit', '0'])).toThrow(/>= 1/);
    expect(loadConfig(['--max-retries', '0'])!.maxRetries).toBe(0);
  });

  it('accepts 0 for the session idle TTL (never expire) but not for other durations', () => {
    expect(loadConfig(['--session-idle-ttl', '0'])!.sessionIdleTtlMs).toBe(0);
    process.env.TRILIUM_SESSION_IDLE_TTL = '0';
    expect(loadConfig([])!.sessionIdleTtlMs).toBe(0);
    expect(() => loadConfig(['--sse-keepalive', '0'])).toThrow(/Invalid duration/);
  });

  it('accepts 0 bytes for size caps (inline nothing)', () => {
    expect(loadConfig(['--max-inline-attachment-bytes', '0'])!.maxInlineAttachmentBytes).toBe(0);
  });
});

describe('numeric tunables from the config file', () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let dir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    dir = await mkdtemp(join(tmpdir(), 'trilium-mcp-tunables-'));
    process.env = { ...originalEnv };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('TRILIUM_')) delete process.env[key];
    }
    process.env.TRILIUM_TOKEN = 't';
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('reads numbers from the file, below env and CLI', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      'trilium-mcp.json',
      JSON.stringify({ maxInlineAttachmentBytes: 1234, maxSessions: 7, sseKeepaliveMs: 999 })
    );
    let config = loadConfig([])!;
    expect(config.maxInlineAttachmentBytes).toBe(1234);
    expect(config.maxSessions).toBe(7);
    expect(config.sseKeepaliveMs).toBe(999);

    process.env.TRILIUM_MAX_SESSIONS = '8';
    config = loadConfig(['--max-inline-attachment-bytes', '1kb'])!;
    expect(config.maxInlineAttachmentBytes).toBe(1024);
    expect(config.maxSessions).toBe(8);
  });

  it('rejects a non-numeric or negative file value', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile('trilium-mcp.json', JSON.stringify({ maxExportBytes: '10mb' }));
    expect(() => loadConfig([])).toThrow(/TRILIUM_MAX_EXPORT_BYTES/);
    await writeFile('trilium-mcp.json', JSON.stringify({ maxSessions: -1 }));
    expect(() => loadConfig([])).toThrow(/TRILIUM_MAX_SESSIONS/);
  });
});

describe('configured limits reach tool schemas and descriptions', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('TRILIUM_')) delete process.env[key];
    }
    process.env.TRILIUM_TOKEN = 'token';
  });

  afterEach(() => {
    // Restore every module to its defaults for the other test files.
    configureTools(loadConfig([])!);
    process.env = originalEnv;
  });

  type JsonProps = Record<string, { maximum?: number; default?: unknown; description?: string }>;
  const props = (tool: { inputSchema: unknown }): JsonProps =>
    (tool.inputSchema as { properties: JsonProps }).properties;

  it('rebuilds descriptions, defaults and bounds from config', () => {
    configureTools(
      loadConfig([
        '--max-inline-attachment-bytes',
        '2mb',
        '--max-export-bytes',
        '3mb',
        '--max-note-image-bytes',
        '512kb',
        '--content-char-cap',
        '1000',
        '--content-max-chars-limit',
        '5000',
        '--default-search-limit',
        '20',
        '--max-search-limit',
        '100',
        '--search-fast-min-results',
        '3',
        '--history-limit',
        '10',
        '--history-max-limit',
        '40',
        '--note-max-backlinks',
        '7',
        '--tree-max-notes',
        '33',
      ])!
    );

    const attachment = registerAttachmentTools().find((t) => t.name === 'get_attachment')!;
    expect(attachment.description).toContain('2 MB');
    const system = registerSystemTools().find((t) => t.name === 'manage_system')!;
    expect(system.description).toContain('max 3 MB');

    const notes = registerNoteTools();
    const getNote = notes.find((t) => t.name === 'get_note')!;
    expect(getNote.description).toContain('Bodies over 1000 characters');
    expect(props(getNote).content_max_chars).toMatchObject({ maximum: 5000, default: 1000 });
    expect(props(getNote).includeImages.description).toContain('~0.5 MB each');
    expect(props(getNote).include_backlinks.description).toContain('max 7');
    const history = notes.find((t) => t.name === 'get_note_history')!;
    expect(props(history).limit).toMatchObject({ maximum: 40, default: 10 });

    const search = registerSearchTools();
    const searchNotes = search.find((t) => t.name === 'search_notes')!;
    expect(props(searchNotes).limit.maximum).toBe(100);
    expect(props(searchNotes).limit.description).toContain('default 20');
    expect(props(searchNotes).strategy.description).toContain('fewer than 3 notes');
    expect(search.find((t) => t.name === 'get_note_tree')!.description).toContain('At most 33');
  });

  it('feeds the fuzzy fallback limits', () => {
    configureTools(
      loadConfig([
        '--fuzzy-max-terms',
        '2',
        '--fuzzy-recall-multiplier',
        '2',
        '--fuzzy-recall-cap',
        '10',
        '--max-search-limit',
        '15',
      ])!
    );
    expect(extractFuzzyTerms('alpha beta gamma delta')).toEqual(['alpha', 'beta']);
    expect(resolveFuzzyLimit(4)).toEqual({ fetchLimit: 8, sliceTo: 4 });
    expect(resolveFuzzyLimit(12).fetchLimit).toBe(12);
    expect(resolveFuzzyLimit(20).fetchLimit).toBe(15); // clamped to the search ceiling
  });
});
