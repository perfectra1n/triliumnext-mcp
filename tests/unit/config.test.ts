import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, normalizeServerUrl, deriveWebBaseUrl, ConfigError } from '../../src/config.js';

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
    delete process.env.TRILIUM_PUBLIC_URL;
    delete process.env.TRILIUM_HTTP_HOST;
    delete process.env.TRILIUM_ALLOWED_HOSTS;
    delete process.env.TRILIUM_RATE_LIMIT_RPS;
    delete process.env.TRILIUM_RATE_LIMIT_BURST;
    delete process.env.TRILIUM_JWT_JWKS_URL;
    delete process.env.TRILIUM_JWT_AUDIENCE;
    delete process.env.TRILIUM_JWT_SECRETS;
    delete process.env.TRILIUM_ALLOW_LOCAL_FILE_READ;
    delete process.env.TRILIUM_LOCAL_FILE_ROOTS;
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

  describe('publicUrl', () => {
    it('defaults to null when not provided', () => {
      process.env.TRILIUM_TOKEN = 'test-token';
      const config = loadConfig([]);
      expect(config!.publicUrl).toBeNull();
    });

    it('reads --public-url and strips trailing slashes', () => {
      process.env.TRILIUM_TOKEN = 'test-token';
      const config = loadConfig(['--public-url', 'https://trilium.example.com/']);
      expect(config!.publicUrl).toBe('https://trilium.example.com');
    });

    it('reads TRILIUM_PUBLIC_URL from the environment', () => {
      process.env.TRILIUM_TOKEN = 'test-token';
      process.env.TRILIUM_PUBLIC_URL = 'https://notes.example.com';
      const config = loadConfig([]);
      expect(config!.publicUrl).toBe('https://notes.example.com');
    });

    it('strips an accidental /etapi suffix from the public URL', () => {
      process.env.TRILIUM_TOKEN = 'test-token';
      const config = loadConfig(['--public-url', 'https://notes.example.com/etapi']);
      expect(config!.publicUrl).toBe('https://notes.example.com');
    });

    it('--public-url takes priority over TRILIUM_PUBLIC_URL', () => {
      process.env.TRILIUM_TOKEN = 'test-token';
      process.env.TRILIUM_PUBLIC_URL = 'https://env.example.com';
      const config = loadConfig(['--public-url', 'https://cli.example.com']);
      expect(config!.publicUrl).toBe('https://cli.example.com');
    });
  });

  describe('deriveWebBaseUrl', () => {
    it('strips a trailing /etapi segment', () => {
      expect(deriveWebBaseUrl('http://localhost:37740/etapi')).toBe('http://localhost:37740');
    });

    it('leaves a bare web root unchanged', () => {
      expect(deriveWebBaseUrl('http://localhost:37740')).toBe('http://localhost:37740');
    });

    it('removes trailing slashes', () => {
      expect(deriveWebBaseUrl('http://localhost:37740/etapi/')).toBe('http://localhost:37740');
    });
  });

  describe('multi-tenant mode', () => {
    it('skips required-token check when --multi-tenant is set', () => {
      const config = loadConfig([
        '--transport',
        'http',
        '--multi-tenant',
        '--gateway-token',
        'abc',
      ]);
      expect(config).not.toBeNull();
      expect(config!.multiTenant).toBe(true);
      expect(config!.triliumToken).toBeNull();
      expect(config!.triliumUrl).toBeNull();
    });

    it('defaults gateway-auth to bearer when multi-tenant is on', () => {
      const config = loadConfig([
        '--transport',
        'http',
        '--multi-tenant',
        '--gateway-token',
        'abc',
      ]);
      expect(config!.gatewayAuth).toBe('bearer');
      expect(config!.gatewayTokens).toEqual(['abc']);
    });

    it('defaults gateway-auth to none when multi-tenant is off', () => {
      process.env.TRILIUM_TOKEN = 't';
      const config = loadConfig([]);
      expect(config!.gatewayAuth).toBe('none');
    });

    it('exits when --multi-tenant is used with stdio transport', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => loadConfig(['--multi-tenant', '--gateway-token', 'abc'])).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('exits when --gateway-auth bearer has no tokens', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
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
        '--transport',
        'http',
        '--multi-tenant',
        '--gateway-token',
        'tok1',
        '--gateway-token',
        'tok2',
      ]);
      expect(config!.gatewayTokens).toEqual(['tok1', 'tok2']);
    });

    it('parses --trilium-url-allowlist', () => {
      const config = loadConfig([
        '--transport',
        'http',
        '--multi-tenant',
        '--gateway-token',
        'tok',
        '--trilium-url-allowlist',
        'a.example.com,b.example.com',
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
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => loadConfig([])).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('rejects --url passed alongside --multi-tenant', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() =>
        loadConfig([
          '--transport',
          'http',
          '--multi-tenant',
          '--gateway-token',
          'abc',
          '--url',
          'http://trilium.example.com',
        ])
      ).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('rejects --token passed alongside --multi-tenant', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() =>
        loadConfig([
          '--transport',
          'http',
          '--multi-tenant',
          '--gateway-token',
          'abc',
          '--token',
          'default-etapi-token',
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
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => loadConfig([])).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('multi-tenant config has null triliumUrl and triliumToken', () => {
      const config = loadConfig([
        '--transport',
        'http',
        '--multi-tenant',
        '--gateway-token',
        'abc',
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
        '--transport',
        'http',
        '--multi-tenant',
        '--gateway-token',
        'gw-secret',
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
      const warned = errSpy.mock.calls
        .flat()
        .some(
          (arg) =>
            typeof arg === 'string' &&
            arg.includes('--metrics has no effect with --transport stdio')
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
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() =>
        loadConfig([
          '--transport',
          'http',
          '--multi-tenant',
          '--gateway-token',
          'gw',
          '--metrics',
          '--metrics-auth',
          'bearer',
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
      const config = loadConfig(['--transport', 'http', '--metrics', '--metrics-auth', 'gateway']);
      expect(config!.gatewayAuth).toBe('none');
      expect(config!.metricsAuth).toBe('none');
      const warned = errSpy.mock.calls
        .flat()
        .some(
          (arg) => typeof arg === 'string' && arg.includes('Falling back to --metrics-auth=none')
        );
      expect(warned).toBe(true);
      errSpy.mockRestore();
    });

    it('accepts repeated --metrics-token flags', () => {
      const config = loadConfig([
        '--transport',
        'http',
        '--multi-tenant',
        '--gateway-token',
        'gw',
        '--metrics',
        '--metrics-auth',
        'bearer',
        '--metrics-token',
        'scrape-1',
        '--metrics-token',
        'scrape-2',
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

    it('rejects unknown metrics-auth values with an error listing valid values', () => {
      expect(() =>
        loadConfig([
          '--transport',
          'http',
          '--multi-tenant',
          '--gateway-token',
          'gw',
          '--metrics',
          '--metrics-auth',
          'wat',
        ])
      ).toThrow(/metrics auth mode.*gateway, bearer, none/);
    });

    it('exits in bearer mode even when --metrics-auth comes from env', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
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

describe('config strictness', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('TRILIUM_')) delete process.env[key];
    }
    process.env.TRILIUM_TOKEN = 't';
  });
  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('defaults the HTTP bind host to 127.0.0.1', () => {
    const config = loadConfig(['--transport', 'http']);
    expect(config!.httpHost).toBe('127.0.0.1');
    expect(config!.allowedHosts).toEqual([]);
  });

  it('reads --host, TRILIUM_HTTP_HOST and allowed hosts', () => {
    expect(loadConfig(['--host', '0.0.0.0'])!.httpHost).toBe('0.0.0.0');
    process.env.TRILIUM_HTTP_HOST = '::';
    process.env.TRILIUM_ALLOWED_HOSTS = 'mcp.example.com,proxy.local:8443';
    const config = loadConfig([]);
    expect(config!.httpHost).toBe('::');
    expect(config!.allowedHosts).toEqual(['mcp.example.com', 'proxy.local:8443']);
    expect(loadConfig(['--allowed-hosts', 'a.example'])!.allowedHosts).toEqual(['a.example']);
  });

  it('defaults maxPostBytes to 64 MB', () => {
    expect(loadConfig([])!.maxPostBytes).toBe(64 * 1024 * 1024);
  });

  it.each([['berer'], ['JWT-ish'], ['']])('rejects unknown --gateway-auth value %j', (value) => {
    expect(() => loadConfig(['--transport', 'http', '--gateway-auth', value])).toThrow(ConfigError);
  });

  it('error for an unknown gateway auth lists the valid values', () => {
    process.env.TRILIUM_GATEWAY_AUTH = 'nope';
    expect(() => loadConfig(['--transport', 'http'])).toThrow(/none, bearer, jwt/);
  });

  it('accepts gateway auth values case-insensitively with whitespace', () => {
    process.env.TRILIUM_GATEWAY_AUTH = '  NONE ';
    expect(loadConfig(['--transport', 'http'])!.gatewayAuth).toBe('none');
  });

  it.each([['0'], ['65536'], ['-1'], ['abc'], ['80.5'], ['3000x']])(
    'rejects invalid --port %s',
    (port) => {
      expect(() => loadConfig(['--port', port])).toThrow(/Invalid port/);
    }
  );

  it('rejects an invalid TRILIUM_HTTP_PORT', () => {
    process.env.TRILIUM_HTTP_PORT = '99999';
    expect(() => loadConfig([])).toThrow(/TRILIUM_HTTP_PORT/);
  });

  it.each([['--url'], ['--token'], ['--port'], ['--gateway-token'], ['--cors-origin'], ['--host']])(
    '%s without a value is an error',
    (flag) => {
      expect(() => loadConfig([flag])).toThrow(/requires a value/);
    }
  );

  it('a flag value that is itself a --flag is an error', () => {
    expect(() => loadConfig(['--token', '--transport', 'http'])).toThrow(
      /--token requires a value/
    );
  });

  it('rejects negative or non-numeric rate limits from env', () => {
    process.env.TRILIUM_RATE_LIMIT_RPS = '-1';
    expect(() => loadConfig([])).toThrow(/rate-limit rps/);
    process.env.TRILIUM_RATE_LIMIT_RPS = '5';
    process.env.TRILIUM_RATE_LIMIT_BURST = 'lots';
    expect(() => loadConfig([])).toThrow(/rate-limit burst/);
  });

  it('rejects an invalid --rate-limit-rps from the CLI', () => {
    expect(() => loadConfig(['--rate-limit-rps', 'fast'])).toThrow(/rate-limit rps/);
  });

  it('accepts valid rate limits from env', () => {
    process.env.TRILIUM_RATE_LIMIT_RPS = '2.5';
    process.env.TRILIUM_RATE_LIMIT_BURST = '10';
    const config = loadConfig([]);
    expect(config!.rateLimitRps).toBe(2.5);
    expect(config!.rateLimitBurst).toBe(10);
  });

  it('rejects an unparseable --max-post-bytes', () => {
    expect(() => loadConfig(['--max-post-bytes', 'huge'])).toThrow(/Invalid size/);
  });

  it('multi-tenant + local file reads without roots is fatal', () => {
    delete process.env.TRILIUM_TOKEN;
    expect(() =>
      loadConfig([
        '--transport',
        'http',
        '--multi-tenant',
        '--gateway-token',
        'gw',
        '--allow-local-file-read',
      ])
    ).toThrow(/--local-file-roots/);
  });

  it('multi-tenant + local file reads WITH roots is allowed', () => {
    delete process.env.TRILIUM_TOKEN;
    const config = loadConfig([
      '--transport',
      'http',
      '--multi-tenant',
      '--gateway-token',
      'gw',
      '--allow-local-file-read',
      '--local-file-roots',
      '/srv/uploads',
    ]);
    expect(config!.localFileRoots).toEqual(['/srv/uploads']);
  });

  it('warns (not fatal) when JWKS is configured without an audience', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig([
      '--transport',
      'http',
      '--gateway-auth',
      'jwt',
      '--jwt-jwks-url',
      'https://idp.example.com/jwks.json',
    ]);
    expect(config!.gatewayAuth).toBe('jwt');
    expect(
      errSpy.mock.calls.flat().some((a) => typeof a === 'string' && a.includes('--jwt-audience'))
    ).toBe(true);
  });

  it('does not warn when JWKS has an audience', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig([
      '--transport',
      'http',
      '--gateway-auth',
      'jwt',
      '--jwt-jwks-url',
      'https://idp.example.com/jwks.json',
      '--jwt-audience',
      'mcp',
    ]);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe('config file parse errors', () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let dir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    dir = await mkdtemp(join(tmpdir(), 'trilium-mcp-cfg-'));
    process.env = { ...originalEnv, TRILIUM_TOKEN: 't' };
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    vi.restoreAllMocks();
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('warns on stderr when ./trilium-mcp.json exists but is invalid JSON', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile('trilium-mcp.json', '{ not json');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig([]);
    expect(config).not.toBeNull();
    expect(
      errSpy.mock.calls
        .flat()
        .some((a) => typeof a === 'string' && a.includes('ignoring config file'))
    ).toBe(true);
  });

  it('validates httpPort from the config file', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile('trilium-mcp.json', JSON.stringify({ httpPort: 70000 }));
    expect(() => loadConfig([])).toThrow(/config file httpPort/);
  });

  it('validates gatewayAuth from the config file', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile('trilium-mcp.json', JSON.stringify({ gatewayAuth: 'token' }));
    expect(() => loadConfig(['--transport', 'http'])).toThrow(/gateway auth mode/);
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

describe('content input policy config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of [
      'TRILIUM_URL',
      'TRILIUM_TOKEN',
      'TRILIUM_TRANSPORT',
      'TRILIUM_MULTI_TENANT',
      'TRILIUM_GATEWAY_AUTH',
      'TRILIUM_GATEWAY_TOKENS',
      'TRILIUM_ALLOW_LOCAL_FILE_READ',
      'TRILIUM_LOCAL_FILE_ROOTS',
      'TRILIUM_CONTENT_URL_ALLOWLIST',
      'TRILIUM_MAX_CONTENT_FETCH_BYTES',
    ]) {
      delete process.env[key];
    }
    process.env.TRILIUM_TOKEN = 'test-token';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults: local reads allowed on stdio, no roots, no URL allowlist, 50 MB cap', () => {
    const config = loadConfig([]);
    expect(config!.allowLocalFileRead).toBe(true);
    expect(config!.localFileRoots).toEqual([]);
    expect(config!.contentUrlAllowlist).toEqual([]);
    expect(config!.maxContentFetchBytes).toBe(50 * 1024 * 1024);
  });

  it('defaults local reads OFF for the http transport', () => {
    const config = loadConfig(['--transport', 'http']);
    expect(config!.allowLocalFileRead).toBe(false);
  });

  it('--allow-local-file-read overrides the http default', () => {
    const config = loadConfig(['--transport', 'http', '--allow-local-file-read']);
    expect(config!.allowLocalFileRead).toBe(true);
  });

  it('--no-local-file-read overrides the stdio default', () => {
    const config = loadConfig(['--no-local-file-read']);
    expect(config!.allowLocalFileRead).toBe(false);
  });

  it('TRILIUM_ALLOW_LOCAL_FILE_READ env var is honored', () => {
    process.env.TRILIUM_ALLOW_LOCAL_FILE_READ = 'false';
    const config = loadConfig([]);
    expect(config!.allowLocalFileRead).toBe(false);
  });

  it('--local-file-roots parses a CSV list', () => {
    const config = loadConfig(['--local-file-roots', '/tmp, /home/user/uploads']);
    expect(config!.localFileRoots).toEqual(['/tmp', '/home/user/uploads']);
  });

  it('TRILIUM_LOCAL_FILE_ROOTS env var is honored', () => {
    process.env.TRILIUM_LOCAL_FILE_ROOTS = '/srv/data';
    const config = loadConfig([]);
    expect(config!.localFileRoots).toEqual(['/srv/data']);
  });

  it('--content-url-allowlist parses a CSV list', () => {
    const config = loadConfig(['--content-url-allowlist', 'example.com,cdn.example.org']);
    expect(config!.contentUrlAllowlist).toEqual(['example.com', 'cdn.example.org']);
  });

  it('TRILIUM_CONTENT_URL_ALLOWLIST env var is honored', () => {
    process.env.TRILIUM_CONTENT_URL_ALLOWLIST = 'files.example.net';
    const config = loadConfig([]);
    expect(config!.contentUrlAllowlist).toEqual(['files.example.net']);
  });

  it('--max-content-fetch-bytes accepts suffixed sizes', () => {
    const config = loadConfig(['--max-content-fetch-bytes', '10mb']);
    expect(config!.maxContentFetchBytes).toBe(10 * 1024 * 1024);
  });

  it('TRILIUM_MAX_CONTENT_FETCH_BYTES env var is honored', () => {
    process.env.TRILIUM_MAX_CONTENT_FETCH_BYTES = '1mb';
    const config = loadConfig([]);
    expect(config!.maxContentFetchBytes).toBe(1024 * 1024);
  });
});

describe('trusted proxies, content private URLs and strict env parsing', () => {
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

  it('reads trusted proxies from CLI (repeatable) and env, and validates them', () => {
    expect(loadConfig([])!.trustedProxies).toEqual([]);
    process.env.TRILIUM_TRUSTED_PROXIES = '10.0.0.0/8, fd00::/8';
    expect(loadConfig([])!.trustedProxies).toEqual(['10.0.0.0/8', 'fd00::/8']);
    expect(
      loadConfig(['--trusted-proxies', '172.16.0.1', '--trusted-proxies', '127.0.0.1'])!
        .trustedProxies
    ).toEqual(['172.16.0.1', '127.0.0.1']);
    expect(() => loadConfig(['--trusted-proxies', 'proxy.internal'])).toThrow(ConfigError);
    expect(() => loadConfig(['--trusted-proxies', '10.0.0.0/40'])).toThrow(/trusted proxy/);
  });

  it('defaults content private URLs to off, independent of --allow-private-urls in multi-tenant mode', () => {
    const mt = ['--transport', 'http', '--multi-tenant', '--gateway-auth', 'none'];
    delete process.env.TRILIUM_TOKEN;
    expect(loadConfig(mt)!.contentAllowPrivateUrls).toBe(false);
    const both = loadConfig([...mt, '--allow-private-urls'])!;
    expect(both.allowPrivateUrls).toBe(true);
    expect(both.contentAllowPrivateUrls).toBe(false);
    expect(loadConfig([...mt, '--content-allow-private-urls'])!.contentAllowPrivateUrls).toBe(true);
    process.env.TRILIUM_CONTENT_ALLOW_PRIVATE_URLS = 'true';
    const envOnly = loadConfig(mt)!;
    expect(envOnly.contentAllowPrivateUrls).toBe(true);
    expect(envOnly.allowPrivateUrls).toBe(false);
  });

  it('keeps --allow-private-urls governing content fetches in single-tenant mode (backward compatible)', () => {
    expect(loadConfig([])!.contentAllowPrivateUrls).toBe(false);
    expect(loadConfig(['--allow-private-urls'])!.contentAllowPrivateUrls).toBe(true);
    process.env.TRILIUM_CONTENT_ALLOW_PRIVATE_URLS = 'false';
    expect(loadConfig(['--allow-private-urls'])!.contentAllowPrivateUrls).toBe(false);
  });

  it.each([
    ['TRILIUM_ALLOW_PRIVATE_URLS', 'ture'],
    ['TRILIUM_CONTENT_ALLOW_PRIVATE_URLS', 'maybe'],
    ['TRILIUM_MULTI_TENANT', 'on'],
    ['TRILIUM_METRICS', 'enabled'],
  ])('rejects an unparseable boolean %s=%s', (env, raw) => {
    process.env[env] = raw;
    expect(() => loadConfig([])).toThrow(new RegExp(env));
  });

  it('treats an empty boolean env value as unset', () => {
    process.env.TRILIUM_ALLOW_PRIVATE_URLS = '';
    expect(loadConfig([])!.allowPrivateUrls).toBe(false);
  });

  it('parses the transport case-insensitively and rejects unknown values', () => {
    process.env.TRILIUM_TRANSPORT = 'HTTP';
    expect(loadConfig([])!.transport).toBe('http');
    process.env.TRILIUM_TRANSPORT = 'websocket';
    expect(() => loadConfig([])).toThrow(/Invalid transport/);
  });
});
