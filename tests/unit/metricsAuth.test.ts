import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { GatewayAuth } from '../../src/http/auth.js';
import { MetricsAuth } from '../../src/http/metricsAuth.js';

function fakeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('MetricsAuth', () => {
  describe('mode=none', () => {
    it('always authorizes, regardless of headers', () => {
      const a = new MetricsAuth('none', { gateway: null, bearerTokens: [] });
      expect(a.isAuthorized(fakeReq({}))).toBe(true);
      expect(a.isAuthorized(fakeReq({ authorization: 'Bearer wrong' }))).toBe(true);
    });
  });

  describe('mode=gateway', () => {
    it('reuses the supplied GatewayAuth instance', () => {
      const gateway = new GatewayAuth(['gateway-secret']);
      const a = new MetricsAuth('gateway', { gateway, bearerTokens: [] });
      expect(a.isAuthorized(fakeReq({ authorization: 'Bearer gateway-secret' }))).toBe(true);
      expect(a.isAuthorized(fakeReq({ authorization: 'Bearer wrong' }))).toBe(false);
      expect(a.isAuthorized(fakeReq({}))).toBe(false);
    });

    it('denies when no gateway was configured (e.g. gateway-auth=none upstream)', () => {
      const a = new MetricsAuth('gateway', { gateway: null, bearerTokens: [] });
      expect(a.isAuthorized(fakeReq({ authorization: 'Bearer anything' }))).toBe(false);
    });
  });

  describe('mode=bearer', () => {
    it('accepts only the configured metrics tokens (not gateway tokens)', () => {
      const gateway = new GatewayAuth(['gateway-secret']);
      const a = new MetricsAuth('bearer', {
        gateway,
        bearerTokens: ['scrape-secret-1', 'scrape-secret-2'],
      });
      expect(a.isAuthorized(fakeReq({ authorization: 'Bearer scrape-secret-1' }))).toBe(true);
      expect(a.isAuthorized(fakeReq({ authorization: 'Bearer scrape-secret-2' }))).toBe(true);
      // Gateway token must NOT pass when metricsAuth=bearer.
      expect(a.isAuthorized(fakeReq({ authorization: 'Bearer gateway-secret' }))).toBe(false);
      expect(a.isAuthorized(fakeReq({}))).toBe(false);
    });

    it('with empty token list, denies everything (defense in depth — loadConfig already rejects this)', () => {
      const a = new MetricsAuth('bearer', { gateway: null, bearerTokens: [] });
      expect(a.isAuthorized(fakeReq({ authorization: 'Bearer anything' }))).toBe(false);
    });
  });
});
