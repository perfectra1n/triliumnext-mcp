import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, normalizeServerUrl } from '../../src/config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    // Start each test from a clean env so TRILIUM_* vars from the shell
    // don't leak in (this test suite runs inside the project's own devshell).
    process.env = { ...originalEnv };
    delete process.env.TRILIUM_URL;
    delete process.env.TRILIUM_TOKEN;
    delete process.env.TRILIUM_TRANSPORT;
    delete process.env.TRILIUM_HTTP_PORT;
    delete process.env.TRILIUM_MULTI_TENANT;
    delete process.env.TRILIUM_GATEWAY_AUTH;
    delete process.env.TRILIUM_GATEWAY_TOKENS;
    delete process.env.TRILIUM_URL_ALLOWLIST;
    delete process.env.TRILIUM_ALLOW_PRIVATE_URLS;
    delete process.env.TRILIUM_MAX_POST_BYTES;
    delete process.env.TRILIUM_METRICS;
    delete process.env.TRILIUM_METRICS_AUTH;
    delete process.env.TRILIUM_METRICS_TOKENS;
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

  it('should normalize URL by appending /etapi when missing', () => {
    process.env.TRILIUM_TOKEN = 'test-token';

    const config = loadConfig(['--url', 'http://localhost:8080']);
    expect(config).not.toBeNull();
    expect(config!.triliumUrl).toBe('http://localhost:8080/etapi');
  });

  it('should not double-append /etapi when already present', () => {
    process.env.TRILIUM_TOKEN = 'test-token';

    const config = loadConfig(['--url', 'http://localhost:8080/etapi']);
    expect(config).not.toBeNull();
    expect(config!.triliumUrl).toBe('http://localhost:8080/etapi');
  });

  it('should strip trailing slashes before appending /etapi', () => {
    process.env.TRILIUM_TOKEN = 'test-token';

    const config = loadConfig(['--url', 'http://localhost:8080/']);
    expect(config).not.toBeNull();
    expect(config!.triliumUrl).toBe('http://localhost:8080/etapi');
  });

  describe('multi-tenant mode', () => {
    it('skips required-token check when --multi-tenant is set', () => {
      const config = loadConfig(['--transport', 'http', '--multi-tenant', '--gateway-token', 'abc']);
      expect(config).not.toBeNull();
      expect(config!.multiTenant).toBe(true);
      expect(config!.triliumToken).toBeNull();
      expect(config!.triliumUrl).toBeNull();
    });

    it('defaults gateway-auth to bearer when multi-tenant is on', () => {
      const config = loadConfig(['--transport', 'http', '--multi-tenant', '--gateway-token', 'abc']);
      expect(config!.gatewayAuth).toBe('bearer');
      expect(config!.gatewayTokens).toEqual(['abc']);
    });

    it('defaults gateway-auth to none when multi-tenant is off', () => {
      process.env.TRILIUM_TOKEN = 't';
      const config = loadConfig([]);
      expect(config!.gatewayAuth).toBe('none');
    });

    it('exits when --multi-tenant is used with stdio transport', () => {
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => { throw new Error('exit'); });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => loadConfig(['--multi-tenant', '--gateway-token', 'abc'])).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('exits when --gateway-auth bearer has no tokens', () => {
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => { throw new Error('exit'); });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() =>
        loadConfig(['--transport', 'http', '--multi-tenant', '--gateway-auth', 'bearer'])
      ).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('accepts multiple --gateway-token flags', () => {
      const config = loadConfig([
        '--transport', 'http',
        '--multi-tenant',
        '--gateway-token', 'tok1',
        '--gateway-token', 'tok2',
      ]);
      expect(config!.gatewayTokens).toEqual(['tok1', 'tok2']);
    });

    it('parses --trilium-url-allowlist', () => {
      const config = loadConfig([
        '--transport', 'http',
        '--multi-tenant',
        '--gateway-token', 'tok',
        '--trilium-url-allowlist', 'a.example.com,b.example.com',
      ]);
      expect(config!.urlAllowlist).toEqual(['a.example.com', 'b.example.com']);
    });

    it('reads multi-tenant settings from env vars', () => {
      process.env.TRILIUM_TRANSPORT = 'http';
      process.env.TRILIUM_MULTI_TENANT = 'true';
      process.env.TRILIUM_GATEWAY_TOKENS = 'env-tok-1,env-tok-2';
      process.env.TRILIUM_URL_ALLOWLIST = 'x.com,y.com';
      process.env.TRILIUM_ALLOW_PRIVATE_URLS = 'true';
      const config = loadConfig([]);
      expect(config!.multiTenant).toBe(true);
      expect(config!.gatewayAuth).toBe('bearer');
      expect(config!.gatewayTokens).toEqual(['env-tok-1', 'env-tok-2']);
      expect(config!.urlAllowlist).toEqual(['x.com', 'y.com']);
      expect(config!.allowPrivateUrls).toBe(true);
    });

    it('single-tenant still requires a token', () => {
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => { throw new Error('exit'); });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => loadConfig([])).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('rejects --url passed alongside --multi-tenant', () => {
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => { throw new Error('exit'); });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() =>
        loadConfig([
          '--transport', 'http',
          '--multi-tenant',
          '--gateway-token', 'abc',
          '--url', 'http://trilium.example.com',
        ])
      ).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('rejects --token passed alongside --multi-tenant', () => {
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => { throw new Error('exit'); });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() =>
        loadConfig([
          '--transport', 'http',
          '--multi-tenant',
          '--gateway-token', 'abc',
          '--token', 'default-etapi-token',
        ])
      ).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('rejects env TRILIUM_URL set alongside multi-tenant', () => {
      process.env.TRILIUM_TRANSPORT = 'http';
      process.env.TRILIUM_MULTI_TENANT = 'true';
      process.env.TRILIUM_GATEWAY_TOKENS = 'abc';
      process.env.TRILIUM_URL = 'http://trilium.example.com';
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => { throw new Error('exit'); });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => loadConfig([])).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('multi-tenant config has null triliumUrl and triliumToken', () => {
      const config = loadConfig([
        '--transport', 'http',
        '--multi-tenant',
        '--gateway-token', 'abc',
      ]);
      expect(config!.triliumUrl).toBeNull();
      expect(config!.triliumToken).toBeNull();
    });
  });

  describe('metrics', () => {
    it('is off by default — operators must opt in', () => {
      process.env.TRILIUM_TOKEN = 't';
      const config = loadConfig([]);
      expect(config!.metricsEnabled).toBe(false);
    });

    it('requires auth by default when enabled (mode=gateway, not none)', () => {
      const config = loadConfig([
        '--transport', 'http',
        '--multi-tenant',
        '--gateway-token', 'gw-secret',
        '--metrics',
      ]);
      expect(config!.metricsEnabled).toBe(true);
      // The KEY invariant: default auth mode is NOT 'none'.
      expect(config!.metricsAuth).toBe('gateway');
      expect(config!.metricsAuth).not.toBe('none');
    });

    it('only runs under HTTP transport — stdio + --metrics warns and disables', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const config = loadConfig(['--token', 't', '--metrics']);
      expect(config!.transport).toBe('stdio');
      expect(config!.metricsEnabled).toBe(false);
      // Operator should be told why their flag was ignored.
      expect(errSpy).toHaveBeenCalled();
      const warned = errSpy.mock.calls.flat().some((arg) =>
        typeof arg === 'string' && arg.includes('--metrics has no effect with --transport stdio')
      );
      expect(warned).toBe(true);
      errSpy.mockRestore();
    });

    it('stdio + TRILIUM_METRICS=true (env form) is also disabled', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.env.TRILIUM_TOKEN = 't';
      process.env.TRILIUM_METRICS = 'true';
      const config = loadConfig([]);
      expect(config!.transport).toBe('stdio');
      expect(config!.metricsEnabled).toBe(false);
      errSpy.mockRestore();
    });

    it('exits when --metrics-auth bearer has no scrape tokens', () => {
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => { throw new Error('exit'); });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() =>
        loadConfig([
          '--transport', 'http',
          '--multi-tenant',
          '--gateway-token', 'gw',
          '--metrics',
          '--metrics-auth', 'bearer',
        ])
      ).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('falls back to none with a warning when gateway-auth is none', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.env.TRILIUM_TOKEN = 't';
      // Single-tenant defaults to gateway-auth=none. Requesting metrics-auth=gateway
      // would be silently equivalent to 'none' — surface that explicitly.
      const config = loadConfig([
        '--transport', 'http',
        '--metrics',
        '--metrics-auth', 'gateway',
      ]);
      expect(config!.gatewayAuth).toBe('none');
      expect(config!.metricsAuth).toBe('none');
      const warned = errSpy.mock.calls.flat().some((arg) =>
        typeof arg === 'string' && arg.includes('Falling back to --metrics-auth=none')
      );
      expect(warned).toBe(true);
      errSpy.mockRestore();
    });

    it('accepts repeated --metrics-token flags', () => {
      const config = loadConfig([
        '--transport', 'http',
        '--multi-tenant',
        '--gateway-token', 'gw',
        '--metrics',
        '--metrics-auth', 'bearer',
        '--metrics-token', 'scrape-1',
        '--metrics-token', 'scrape-2',
      ]);
      expect(config!.metricsAuth).toBe('bearer');
      expect(config!.metricsTokens).toEqual(['scrape-1', 'scrape-2']);
    });

    it('parses env equivalents', () => {
      process.env.TRILIUM_TRANSPORT = 'http';
      process.env.TRILIUM_MULTI_TENANT = 'true';
      process.env.TRILIUM_GATEWAY_TOKENS = 'gw';
      process.env.TRILIUM_METRICS = 'true';
      process.env.TRILIUM_METRICS_AUTH = 'bearer';
      process.env.TRILIUM_METRICS_TOKENS = 's1,s2';
      const config = loadConfig([]);
      expect(config!.metricsEnabled).toBe(true);
      expect(config!.metricsAuth).toBe('bearer');
      expect(config!.metricsTokens).toEqual(['s1', 's2']);
    });

    it('TRILIUM_METRICS=false explicitly disables', () => {
      process.env.TRILIUM_TOKEN = 't';
      process.env.TRILIUM_METRICS = 'false';
      const config = loadConfig([]);
      expect(config!.metricsEnabled).toBe(false);
    });

    it('rejects unknown metrics-auth values, falling back to default (gateway)', () => {
      const config = loadConfig([
        '--transport', 'http',
        '--multi-tenant',
        '--gateway-token', 'gw',
        '--metrics',
        '--metrics-auth', 'wat',
      ]);
      expect(config!.metricsAuth).toBe('gateway');
    });

    it('exits in bearer mode even when --metrics-auth comes from env', () => {
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => { throw new Error('exit'); });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.env.TRILIUM_TRANSPORT = 'http';
      process.env.TRILIUM_MULTI_TENANT = 'true';
      process.env.TRILIUM_GATEWAY_TOKENS = 'gw';
      process.env.TRILIUM_METRICS = 'true';
      process.env.TRILIUM_METRICS_AUTH = 'bearer';
      // no metrics tokens — should fail-fast
      expect(() => loadConfig([])).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });
  });
});

describe('normalizeServerUrl', () => {
  it('should append /etapi to base URL', () => {
    expect(normalizeServerUrl('http://localhost:8080')).toBe('http://localhost:8080/etapi');
  });

  it('should not double-append /etapi', () => {
    expect(normalizeServerUrl('http://localhost:8080/etapi')).toBe('http://localhost:8080/etapi');
  });

  it('should strip trailing slash before appending /etapi', () => {
    expect(normalizeServerUrl('http://localhost:8080/')).toBe('http://localhost:8080/etapi');
  });

  it('should strip multiple trailing slashes', () => {
    expect(normalizeServerUrl('http://localhost:8080///')).toBe('http://localhost:8080/etapi');
  });

  it('should handle URL with trailing slash and /etapi', () => {
    expect(normalizeServerUrl('http://localhost:8080/etapi/')).toBe('http://localhost:8080/etapi');
  });

  it('should handle URL with custom port', () => {
    expect(normalizeServerUrl('http://localhost:37740')).toBe('http://localhost:37740/etapi');
  });

  it('should handle HTTPS URLs', () => {
    expect(normalizeServerUrl('https://trilium.example.com')).toBe(
      'https://trilium.example.com/etapi'
    );
  });

  it('should handle URLs with paths before /etapi', () => {
    expect(normalizeServerUrl('http://localhost/trilium')).toBe('http://localhost/trilium/etapi');
  });
});
