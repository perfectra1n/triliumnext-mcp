import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { SignJWT } from 'jose';
import { GatewayAuth } from '../../src/http/auth.js';
import { JwtAuth } from '../../src/http/jwtAuth.js';
import { GatewayPolicy } from '../../src/http/gatewayPolicy.js';

function fakeReq(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as unknown as IncomingMessage;
}

describe('GatewayPolicy', () => {
  it('mode=none always authorizes with no principal', async () => {
    const policy = new GatewayPolicy('none', null, null);
    const result = await policy.authorize(fakeReq());
    expect(result).toEqual({ authorized: true, principal: null });
  });

  it('mode=bearer delegates to GatewayAuth and returns no principal', async () => {
    const bearer = new GatewayAuth(['secret']);
    const policy = new GatewayPolicy('bearer', bearer, null);
    expect(await policy.authorize(fakeReq('Bearer secret'))).toEqual({
      authorized: true,
      principal: null,
    });
    const denied = await policy.authorize(fakeReq('Bearer wrong'));
    expect(denied.authorized).toBe(false);
    expect(denied.principal).toBeNull();
  });

  it('mode=jwt delegates to JwtAuth and returns the principal', async () => {
    const enc = new TextEncoder();
    const secret = enc.encode('a'.repeat(32));
    const jwt = new JwtAuth({ secrets: ['a'.repeat(32)] });
    const policy = new GatewayPolicy('jwt', null, jwt);
    const token = await new SignJWT({ sub: 'alice@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);
    const result = await policy.authorize(fakeReq(`Bearer ${token}`));
    expect(result.authorized).toBe(true);
    expect(result.principal).toBe('alice@example.com');
  });

  it('throws at construction if mode=bearer but no GatewayAuth provided', () => {
    expect(() => new GatewayPolicy('bearer', null, null)).toThrow(/requires a GatewayAuth/);
  });

  it('throws at construction if mode=jwt but no JwtAuth provided', () => {
    expect(() => new GatewayPolicy('jwt', null, null)).toThrow(/requires a JwtAuth/);
  });
});
