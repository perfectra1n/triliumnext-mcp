import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, parseDuration, ConfigError } from '../../src/config.js';

describe('backend timeout and search config', () => {
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

  it('defaults to a 60s timeout, a 30s busy cooldown and the auto strategy', () => {
    const config = loadConfig([]);
    expect(config?.requestTimeoutMs).toBe(60_000);
    expect(config?.busyCooldownMs).toBe(30_000);
    expect(config?.searchStrategy).toBe('auto');
  });

  it('reads the environment', () => {
    process.env.TRILIUM_REQUEST_TIMEOUT = '90s';
    process.env.TRILIUM_BUSY_COOLDOWN = '2m';
    process.env.TRILIUM_SEARCH_STRATEGY = 'full';
    const config = loadConfig([]);
    expect(config?.requestTimeoutMs).toBe(90_000);
    expect(config?.busyCooldownMs).toBe(120_000);
    expect(config?.searchStrategy).toBe('full');
  });

  it('lets CLI flags win over the environment', () => {
    process.env.TRILIUM_REQUEST_TIMEOUT = '90s';
    const config = loadConfig([
      '--request-timeout',
      '1500',
      '--busy-cooldown',
      '10s',
      '--search-strategy',
      'fast',
    ]);
    expect(config?.requestTimeoutMs).toBe(1500);
    expect(config?.busyCooldownMs).toBe(10_000);
    expect(config?.searchStrategy).toBe('fast');
  });

  it('rejects invalid env values instead of silently using the default', () => {
    process.env.TRILIUM_REQUEST_TIMEOUT = 'soon';
    expect(() => loadConfig([])).toThrow(ConfigError);
    expect(() => loadConfig([])).toThrow(/TRILIUM_REQUEST_TIMEOUT/);
    delete process.env.TRILIUM_REQUEST_TIMEOUT;

    process.env.TRILIUM_BUSY_COOLDOWN = '0';
    expect(() => loadConfig([])).toThrow(/TRILIUM_BUSY_COOLDOWN/);
    delete process.env.TRILIUM_BUSY_COOLDOWN;

    process.env.TRILIUM_SEARCH_STRATEGY = 'thorough';
    expect(() => loadConfig([])).toThrow(/Invalid search strategy: "thorough"/);
    expect(() => loadConfig(['--search-strategy', 'thorough'])).toThrow(ConfigError);
  });

  it('reads the search strategy case-insensitively', () => {
    process.env.TRILIUM_SEARCH_STRATEGY = ' FULL ';
    expect(loadConfig([])?.searchStrategy).toBe('full');
    expect(loadConfig(['--search-strategy', 'Fast'])?.searchStrategy).toBe('fast');
  });
});

describe('parseDuration', () => {
  it.each([
    ['60000', 60_000],
    ['500ms', 500],
    ['90s', 90_000],
    ['1.5s', 1500],
    ['2m', 120_000],
    [' 30S ', 30_000],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(['', 'abc', '-5s', '0', '10h'])('rejects %s', (input) => {
    expect(parseDuration(input)).toBeUndefined();
  });
});

describe('backend timeout CLI validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, TRILIUM_TOKEN: 'token' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('rejects an invalid --request-timeout instead of silently ignoring it', () => {
    expect(() => loadConfig(['--request-timeout', 'soon'])).toThrow(/Invalid duration/);
  });

  it('requires a value for --busy-cooldown and --search-strategy', () => {
    expect(() => loadConfig(['--busy-cooldown'])).toThrow(/requires a value/);
    expect(() => loadConfig(['--search-strategy'])).toThrow(/requires a value/);
  });
});
