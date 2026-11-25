import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  checkRequestOrigin,
  isLoopbackHost,
  parseHostHeader,
  type OriginGuardOptions,
} from '../../src/http/originGuard.js';
import { CorsPolicy } from '../../src/http/cors.js';

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function opts(overrides: Partial<OriginGuardOptions> = {}): OriginGuardOptions {
  return {
    bindHost: '127.0.0.1',
    cors: new CorsPolicy([]),
    allowedHosts: [],
    ...overrides,
  };
}

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]'])(
    'treats %s as loopback',
    (h) => {
      expect(isLoopbackHost(h)).toBe(true);
    }
  );

  it.each(['0.0.0.0', '10.0.0.1', 'example.com', 'localhost.evil.com', '::', '128.0.0.1'])(
    'treats %s as non-loopback',
    (h) => {
      expect(isLoopbackHost(h)).toBe(false);
    }
  );
});

describe('parseHostHeader', () => {
  it('splits hostname and port', () => {
    expect(parseHostHeader('Example.com:8080')).toEqual({ hostname: 'example.com', port: '8080' });
    expect(parseHostHeader('example.com')).toEqual({ hostname: 'example.com', port: null });
    expect(parseHostHeader('[::1]:3000')).toEqual({ hostname: '::1', port: '3000' });
    expect(parseHostHeader('[::1]')).toEqual({ hostname: '::1', port: null });
  });

  it('rejects malformed values', () => {
    expect(parseHostHeader('')).toBeNull();
    expect(parseHostHeader('host:abc')).toBeNull();
    expect(parseHostHeader('[::1')).toBeNull();
    expect(parseHostHeader(':80')).toBeNull();
  });
});

describe('checkRequestOrigin — Host (DNS rebinding)', () => {
  it('accepts loopback Host values when bound to loopback', () => {
    for (const host of ['127.0.0.1:3000', 'localhost:3000', '[::1]:3000', 'localhost']) {
      expect(checkRequestOrigin(req({ host }), opts())).toEqual({ ok: true });
    }
  });

  it('rejects a rebound attacker hostname when bound to loopback', () => {
    expect(checkRequestOrigin(req({ host: 'evil.example:3000' }), opts())).toEqual({
      ok: false,
      reason: 'host_not_allowed',
    });
  });

  it('rejects a missing Host header when bound to loopback', () => {
    expect(checkRequestOrigin(req({}), opts())).toEqual({ ok: false, reason: 'missing_host' });
  });

  it('accepts the bind address itself', () => {
    expect(
      checkRequestOrigin(req({ host: '192.168.1.5:3000' }), opts({ bindHost: '192.168.1.5' }))
    ).toEqual({ ok: true });
  });

  it('accepts allowedHosts entries, with and without a port', () => {
    const o = opts({ allowedHosts: ['mcp.example.com', 'proxy.lan:8443'] });
    expect(checkRequestOrigin(req({ host: 'MCP.example.com' }), o).ok).toBe(true);
    expect(checkRequestOrigin(req({ host: 'mcp.example.com:9999' }), o).ok).toBe(true);
    expect(checkRequestOrigin(req({ host: 'proxy.lan:8443' }), o).ok).toBe(true);
    expect(checkRequestOrigin(req({ host: 'proxy.lan:80' }), o).ok).toBe(false);
    expect(checkRequestOrigin(req({ host: 'other.example.com' }), o).ok).toBe(false);
  });

  it('skips the Host check on a non-loopback bind without allowedHosts (reverse proxy)', () => {
    const o = opts({ bindHost: '0.0.0.0' });
    expect(checkRequestOrigin(req({ host: 'mcp.example.com' }), o)).toEqual({ ok: true });
    expect(checkRequestOrigin(req({}), o)).toEqual({ ok: true });
  });

  it('enforces allowedHosts on a non-loopback bind when configured', () => {
    const o = opts({ bindHost: '0.0.0.0', allowedHosts: ['mcp.example.com'] });
    expect(checkRequestOrigin(req({ host: 'mcp.example.com' }), o).ok).toBe(true);
    // Loopback stays accepted (in-container health checks, sidecars).
    expect(checkRequestOrigin(req({ host: 'localhost:3000' }), o).ok).toBe(true);
    expect(checkRequestOrigin(req({ host: 'evil.example' }), o)).toEqual({
      ok: false,
      reason: 'host_not_allowed',
    });
  });
});

describe('checkRequestOrigin — Origin (cross-site)', () => {
  it('allows requests without an Origin header (non-browser clients)', () => {
    expect(checkRequestOrigin(req({ host: 'localhost' }), opts())).toEqual({ ok: true });
    expect(
      checkRequestOrigin(req({ host: 'mcp.example.com' }), opts({ bindHost: '0.0.0.0' }))
    ).toEqual({ ok: true });
  });

  it('rejects a cross-site Origin that is not on the CORS allowlist', () => {
    expect(
      checkRequestOrigin(req({ host: 'localhost:3000', origin: 'https://evil.example' }), opts())
    ).toEqual({ ok: false, reason: 'origin_not_allowed' });
    expect(
      checkRequestOrigin(
        req({ host: 'mcp.example.com', origin: 'https://evil.example' }),
        opts({ bindHost: '0.0.0.0' })
      )
    ).toEqual({ ok: false, reason: 'origin_not_allowed' });
  });

  it('allows an Origin on the CORS allowlist (case-insensitive)', () => {
    const o = opts({ bindHost: '0.0.0.0', cors: new CorsPolicy(['https://app.example.com']) });
    expect(
      checkRequestOrigin(req({ host: 'mcp.example.com', origin: 'https://APP.example.com' }), o)
    ).toEqual({ ok: true });
  });

  it('allows any Origin in CORS wildcard mode', () => {
    const o = opts({ bindHost: '0.0.0.0', cors: new CorsPolicy(['*']) });
    expect(checkRequestOrigin(req({ host: 'x', origin: 'https://anything.example' }), o).ok).toBe(
      true
    );
  });

  it('allows loopback origins only when the server is bound to loopback', () => {
    const local = req({ host: 'localhost:3000', origin: 'http://localhost:5173' });
    expect(checkRequestOrigin(local, opts()).ok).toBe(true);
    expect(
      checkRequestOrigin(req({ host: '127.0.0.1', origin: 'http://[::1]:5173' }), opts()).ok
    ).toBe(true);
    expect(
      checkRequestOrigin(
        req({ host: 'mcp.example.com', origin: 'http://localhost:5173' }),
        opts({ bindHost: '0.0.0.0' })
      )
    ).toEqual({ ok: false, reason: 'origin_not_allowed' });
  });

  it('rejects the opaque "null" origin unless wildcard CORS is on', () => {
    expect(checkRequestOrigin(req({ host: 'localhost', origin: 'null' }), opts())).toEqual({
      ok: false,
      reason: 'origin_not_allowed',
    });
  });

  it('runs the Host check before the Origin check', () => {
    const o = opts({ cors: new CorsPolicy(['https://app.example.com']) });
    expect(
      checkRequestOrigin(req({ host: 'evil.example', origin: 'https://app.example.com' }), o)
    ).toEqual({ ok: false, reason: 'host_not_allowed' });
  });
});
