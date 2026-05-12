import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CorsPolicy } from '../../src/http/cors.js';

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  ended: boolean;
  body: string;
  setHeader: ReturnType<typeof vi.fn>;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function fakeReq(headers: Record<string, string | undefined>, method = 'GET'): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    ended: false,
    body: '',
    setHeader: vi.fn((k: string, v: string) => {
      res.headers[k.toLowerCase()] = v;
    }),
    writeHead: vi.fn((status: number, hdrs?: Record<string, string>) => {
      res.statusCode = status;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          res.headers[k.toLowerCase()] = v;
        }
      }
    }),
    end: vi.fn((chunk?: string) => {
      if (chunk) res.body += chunk;
      res.ended = true;
    }),
  };
  return res;
}

describe('CorsPolicy', () => {
  describe('disabled (empty origins)', () => {
    const cors = new CorsPolicy([]);

    it('is not enabled', () => {
      expect(cors.enabled).toBe(false);
    });

    it('apply() adds no headers', () => {
      const res = fakeRes();
      cors.apply(fakeReq({ origin: 'https://app.example.com' }), res as unknown as ServerResponse);
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('handlePreflight() returns false (falls through to 404)', () => {
      const res = fakeRes();
      const handled = cors.handlePreflight(
        fakeReq({ origin: 'https://app.example.com' }, 'OPTIONS'),
        res as unknown as ServerResponse
      );
      expect(handled).toBe(false);
    });
  });

  describe('exact-origin allowlist', () => {
    const cors = new CorsPolicy(['https://app.example.com', 'https://admin.example.com']);

    it('echoes the Origin when it matches', () => {
      const res = fakeRes();
      cors.apply(fakeReq({ origin: 'https://app.example.com' }), res as unknown as ServerResponse);
      expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
      expect(res.headers['vary']).toBe('Origin');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-expose-headers']).toContain('MCP-Session-Id');
    });

    it('matches case-insensitively', () => {
      const res = fakeRes();
      cors.apply(
        fakeReq({ origin: 'HTTPS://App.Example.com' }),
        res as unknown as ServerResponse
      );
      // Echo preserves the request casing so the browser sees what it sent.
      expect(res.headers['access-control-allow-origin']).toBe('HTTPS://App.Example.com');
    });

    it('does not echo a non-matching Origin', () => {
      const res = fakeRes();
      cors.apply(fakeReq({ origin: 'https://evil.example.com' }), res as unknown as ServerResponse);
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('does not echo when no Origin header is present', () => {
      const res = fakeRes();
      cors.apply(fakeReq({}), res as unknown as ServerResponse);
      expect(res.setHeader).not.toHaveBeenCalled();
    });
  });

  describe('wildcard origin', () => {
    const cors = new CorsPolicy(['*']);

    it('echoes the request Origin (never literal "*", to keep credentials working)', () => {
      const res = fakeRes();
      cors.apply(
        fakeReq({ origin: 'https://random.example.com' }),
        res as unknown as ServerResponse
      );
      expect(res.headers['access-control-allow-origin']).toBe('https://random.example.com');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });
  });

  describe('preflight (OPTIONS)', () => {
    const cors = new CorsPolicy(['https://app.example.com']);

    it('returns 204 with allow-methods + allow-headers for a valid origin', () => {
      const res = fakeRes();
      const handled = cors.handlePreflight(
        fakeReq(
          {
            origin: 'https://app.example.com',
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'authorization, content-type',
          },
          'OPTIONS'
        ),
        res as unknown as ServerResponse
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
      expect(res.headers['access-control-allow-methods']).toBe('POST');
      // Echoes the requested headers back rather than guessing.
      expect(res.headers['access-control-allow-headers']).toBe('authorization, content-type');
      expect(res.headers['access-control-max-age']).toBe('600');
    });

    it('falls back to a default header set when none requested', () => {
      const res = fakeRes();
      cors.handlePreflight(
        fakeReq({ origin: 'https://app.example.com' }, 'OPTIONS'),
        res as unknown as ServerResponse
      );
      expect(res.headers['access-control-allow-headers']).toContain('Authorization');
      expect(res.headers['access-control-allow-headers']).toContain('X-Trilium-Url');
      expect(res.headers['access-control-allow-headers']).toContain('X-Trilium-Token');
      expect(res.headers['access-control-allow-headers']).toContain('MCP-Session-Id');
    });

    it('returns 403 for an OPTIONS request from a disallowed origin', () => {
      const res = fakeRes();
      const handled = cors.handlePreflight(
        fakeReq({ origin: 'https://evil.example.com' }, 'OPTIONS'),
        res as unknown as ServerResponse
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('cors_origin_rejected');
    });

    it('only acts on OPTIONS — regular methods fall through', () => {
      const res = fakeRes();
      const handled = cors.handlePreflight(
        fakeReq({ origin: 'https://app.example.com' }, 'GET'),
        res as unknown as ServerResponse
      );
      expect(handled).toBe(false);
    });

    it('rejects an unknown method but always permits standard MCP verbs', () => {
      const res = fakeRes();
      cors.handlePreflight(
        fakeReq(
          {
            origin: 'https://app.example.com',
            'access-control-request-method': 'TRACE',
          },
          'OPTIONS'
        ),
        res as unknown as ServerResponse
      );
      expect(res.headers['access-control-allow-methods']).toBe('GET, POST, DELETE, OPTIONS');
    });
  });
});

// Silence the unused-import warning while keeping the type import handy
// for callers that compose with real `http` types.
void Readable;
