import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return null when --help flag is passed', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const config = loadConfig(['--help']);
    expect(config).toBeNull();
    consoleSpy.mockRestore();
  });

  it('should use CLI arguments with highest priority', () => {
    process.env.TRILIUM_URL = 'http://env-url/etapi';
    process.env.TRILIUM_TOKEN = 'env-token';

    const config = loadConfig(['--url', 'http://cli-url/etapi', '--token', 'cli-token']);
    expect(config).not.toBeNull();
    expect(config!.triliumUrl).toBe('http://cli-url/etapi');
    expect(config!.triliumToken).toBe('cli-token');
  });

  it('should use environment variables when CLI not provided', () => {
    process.env.TRILIUM_URL = 'http://env-url/etapi';
    process.env.TRILIUM_TOKEN = 'env-token';

    const config = loadConfig([]);
    expect(config).not.toBeNull();
    expect(config!.triliumUrl).toBe('http://env-url/etapi');
    expect(config!.triliumToken).toBe('env-token');
  });

  it('should default to stdio transport', () => {
    process.env.TRILIUM_TOKEN = 'test-token';

    const config = loadConfig([]);
    expect(config).not.toBeNull();
    expect(config!.transport).toBe('stdio');
  });

  it('should set http transport when specified', () => {
    process.env.TRILIUM_TOKEN = 'test-token';

    const config = loadConfig(['--transport', 'http']);
    expect(config).not.toBeNull();
    expect(config!.transport).toBe('http');
  });

  it('should use default URL when not provided', () => {
    process.env.TRILIUM_TOKEN = 'test-token';

    const config = loadConfig([]);
    expect(config).not.toBeNull();
    expect(config!.triliumUrl).toBe('http://localhost:37740/etapi');
  });

  it('should set HTTP port from CLI', () => {
    process.env.TRILIUM_TOKEN = 'test-token';

    const config = loadConfig(['--port', '8080']);
    expect(config).not.toBeNull();
    expect(config!.httpPort).toBe(8080);
  });

  it('should default HTTP port to 3000', () => {
    process.env.TRILIUM_TOKEN = 'test-token';

    const config = loadConfig([]);
    expect(config).not.toBeNull();
    expect(config!.httpPort).toBe(3000);
  });

  it('should parse short flags correctly', () => {
    const config = loadConfig(['-u', 'http://short-url/etapi', '-t', 'short-token', '-p', '4000']);
    expect(config).not.toBeNull();
    expect(config!.triliumUrl).toBe('http://short-url/etapi');
    expect(config!.triliumToken).toBe('short-token');
    expect(config!.httpPort).toBe(4000);
  });
});
