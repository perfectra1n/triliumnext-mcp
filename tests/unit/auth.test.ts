import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { GatewayAuth, extractBearerToken } from '../../src/http/auth.js';

function fakeReq(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('extractBearerToken', () => {
  it('parses "Bearer <token>"', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
    expect(extractBearerToken('BEARER abc123')).toBe('abc123');
  });

  it('ignores trailing whitespace', () => {
    expect(extractBearerToken('Bearer abc123   ')).toBe('abc123');
  });

  it('rejects missing scheme', () => {
    expect(extractBearerToken('abc123')).toBeNull();
  });

  it('rejects other schemes', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
  });

  it('returns null on undefined', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('handles array header (first element)', () => {
    expect(extractBearerToken(['Bearer abc', 'Bearer xyz'])).toBe('abc');
  });

  it('rejects empty token', () => {
    expect(extractBearerToken('Bearer ')).toBeNull();
  });
});

describe('GatewayAuth', () => {
  it('authorizes a valid token', () => {
    const auth = new GatewayAuth(['secret-a', 'secret-b']);
    expect(auth.isAuthorized(fakeReq({ authorization: 'Bearer secret-a' }))).toBe(true);
    expect(auth.isAuthorized(fakeReq({ authorization: 'Bearer secret-b' }))).toBe(true);
  });

  it('rejects an unknown token', () => {
    const auth = new GatewayAuth(['secret-a']);
    expect(auth.isAuthorized(fakeReq({ authorization: 'Bearer wrong' }))).toBe(false);
  });

  it('rejects missing Authorization header', () => {
    const auth = new GatewayAuth(['secret-a']);
    expect(auth.isAuthorized(fakeReq({}))).toBe(false);
  });

  it('rejects malformed scheme', () => {
    const auth = new GatewayAuth(['secret-a']);
    expect(auth.isAuthorized(fakeReq({ authorization: 'Basic secret-a' }))).toBe(false);
  });

  it('returns false when no tokens are configured', () => {
    const auth = new GatewayAuth([]);
    expect(auth.isAuthorized(fakeReq({ authorization: 'Bearer anything' }))).toBe(false);
  });

  it('accepts tokens of different lengths', () => {
    const auth = new GatewayAuth(['short', 'a-much-longer-token-here']);
    expect(auth.isAuthorized(fakeReq({ authorization: 'Bearer short' }))).toBe(true);
    expect(auth.isAuthorized(fakeReq({ authorization: 'Bearer a-much-longer-token-here' }))).toBe(true);
  });
});
