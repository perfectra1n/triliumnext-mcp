import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { SignJWT } from 'jose';
import { JwtAuth } from '../../src/http/jwtAuth.js';

const enc = new TextEncoder();
const SECRET = enc.encode('a'.repeat(32));

function fakeReq(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as unknown as IncomingMessage;
}

async function makeToken(claims: Record<string, unknown>, secret = SECRET): Promise<string> {
  let builder = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' });
  if (!('iat' in claims)) builder = builder.setIssuedAt();
  if (!('exp' in claims)) builder = builder.setExpirationTime('5m');
  return builder.sign(secret);
}

describe('JwtAuth — HS256', () => {
  it('accepts a valid signed token and extracts the principal from `sub`', async () => {
    const auth = new JwtAuth({ secrets: ['a'.repeat(32)] });
    const token = await makeToken({ sub: 'alice@example.com' });
    const res = await auth.authorize(fakeReq(`Bearer ${token}`));
    expect(res.authorized).toBe(true);
    expect(res.principal).toBe('alice@example.com');
  });

  it('rejects a missing Authorization header', async () => {
    const auth = new JwtAuth({ secrets: ['a'.repeat(32)] });
    const res = await auth.authorize(fakeReq());
    expect(res.authorized).toBe(false);
    expect(res.reason).toBe('no_token');
  });

  it('rejects a token signed by a different secret', async () => {
    const auth = new JwtAuth({ secrets: ['a'.repeat(32)] });
    const token = await makeToken({ sub: 'alice' }, enc.encode('b'.repeat(32)));
    const res = await auth.authorize(fakeReq(`Bearer ${token}`));
    expect(res.authorized).toBe(false);
    expect(res.reason).toBe('verify_failed');
  });

  it('rejects an expired token', async () => {
    const auth = new JwtAuth({ secrets: ['a'.repeat(32)] });
    const token = await new SignJWT({ sub: 'alice' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(SECRET);
    const res = await auth.authorize(fakeReq(`Bearer ${token}`));
    expect(res.authorized).toBe(false);
    expect(res.reason).toBe('verify_failed');
  });

  it('accepts when ANY of multiple HS256 secrets verifies (rotation)', async () => {
    const auth = new JwtAuth({ secrets: ['old-secret-aaaaaaaaaaaaaaaaaaaaaaaa', 'a'.repeat(32)] });
    const token = await makeToken({ sub: 'alice' });
    const res = await auth.authorize(fakeReq(`Bearer ${token}`));
    expect(res.authorized).toBe(true);
  });

  it('rejects a malformed JWT', async () => {
    const auth = new JwtAuth({ secrets: ['a'.repeat(32)] });
    const res = await auth.authorize(fakeReq('Bearer not.a.jwt'));
    expect(res.authorized).toBe(false);
    expect(res.reason).toBe('verify_failed');
  });

  it('validates the issuer claim when configured', async () => {
    const auth = new JwtAuth({ secrets: ['a'.repeat(32)], issuer: 'https://idp.example.com' });
    const ok = await makeToken({ sub: 'alice', iss: 'https://idp.example.com' });
    const bad = await makeToken({ sub: 'alice', iss: 'https://wrong.example.com' });
    expect((await auth.authorize(fakeReq(`Bearer ${ok}`))).authorized).toBe(true);
    expect((await auth.authorize(fakeReq(`Bearer ${bad}`))).authorized).toBe(false);
  });

  it('validates the audience claim when configured', async () => {
    const auth = new JwtAuth({ secrets: ['a'.repeat(32)], audience: 'mcp-gateway' });
    const ok = await makeToken({ sub: 'alice', aud: 'mcp-gateway' });
    const bad = await makeToken({ sub: 'alice', aud: 'something-else' });
    expect((await auth.authorize(fakeReq(`Bearer ${ok}`))).authorized).toBe(true);
    expect((await auth.authorize(fakeReq(`Bearer ${bad}`))).authorized).toBe(false);
  });

  it('extracts a custom principal claim', async () => {
    const auth = new JwtAuth({ secrets: ['a'.repeat(32)], principalClaim: 'email' });
    const token = await makeToken({ sub: 'unused', email: 'alice@example.com' });
    const res = await auth.authorize(fakeReq(`Bearer ${token}`));
    expect(res.authorized).toBe(true);
    expect(res.principal).toBe('alice@example.com');
  });

  it('rejects a valid signature but missing principal claim', async () => {
    const auth = new JwtAuth({ secrets: ['a'.repeat(32)], principalClaim: 'email' });
    const token = await makeToken({ sub: 'alice' }); // no email
    const res = await auth.authorize(fakeReq(`Bearer ${token}`));
    expect(res.authorized).toBe(false);
    expect(res.reason).toBe('no_principal');
  });

  it('refuses to construct without any verifier', () => {
    expect(() => new JwtAuth({})).toThrow(/at least one shared secret or a JWKS URL/);
  });

  it('rejects "alg=none" tokens (jose default)', async () => {
    const auth = new JwtAuth({ secrets: ['a'.repeat(32)] });
    // Build a "none" token by hand. SignJWT won't produce one; we craft the bytes.
    const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
    const payload = Buffer.from('{"sub":"alice"}').toString('base64url');
    const noneToken = `${header}.${payload}.`;
    const res = await auth.authorize(fakeReq(`Bearer ${noneToken}`));
    expect(res.authorized).toBe(false);
  });
});
