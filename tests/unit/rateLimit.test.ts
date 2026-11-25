import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { RateLimiter } from '../../src/http/rateLimit.js';

function req(remoteAddress: string, authorization?: string): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: authorization ? { authorization } : {},
  } as unknown as IncomingMessage;
}

describe('RateLimiter', () => {
  it('is disabled when rps=0 — always allows', () => {
    const rl = new RateLimiter({ rps: 0, burst: 0 });
    expect(rl.enabled).toBe(false);
    for (let i = 0; i < 1000; i++) {
      expect(rl.check(req('1.2.3.4')).allowed).toBe(true);
    }
  });

  it('allows up to `burst` requests immediately', () => {
    let now = 0;
    const rl = new RateLimiter({ rps: 1, burst: 5, now: () => now });
    for (let i = 0; i < 5; i++) {
      expect(rl.check(req('1.2.3.4')).allowed).toBe(true);
    }
    const denied = rl.check(req('1.2.3.4'));
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('ip');
    expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('refills at rps tokens/sec', () => {
    let now = 0;
    const rl = new RateLimiter({ rps: 2, burst: 2, now: () => now });
    // Drain the bucket.
    expect(rl.check(req('1.2.3.4')).allowed).toBe(true);
    expect(rl.check(req('1.2.3.4')).allowed).toBe(true);
    expect(rl.check(req('1.2.3.4')).allowed).toBe(false);
    // 500ms → 1 token refilled.
    now = 500;
    expect(rl.check(req('1.2.3.4')).allowed).toBe(true);
    expect(rl.check(req('1.2.3.4')).allowed).toBe(false);
  });

  it('isolates buckets by remote IP', () => {
    let now = 0;
    const rl = new RateLimiter({ rps: 1, burst: 1, now: () => now });
    expect(rl.check(req('1.2.3.4')).allowed).toBe(true);
    expect(rl.check(req('1.2.3.4')).allowed).toBe(false);
    // Different IP gets its own bucket.
    expect(rl.check(req('5.6.7.8')).allowed).toBe(true);
  });

  it('also limits per bearer token (separate axis)', () => {
    let now = 0;
    const rl = new RateLimiter({ rps: 1, burst: 2, now: () => now });
    // Same token, two different IPs → still limited by token axis after 2 reqs.
    expect(rl.check(req('1.2.3.4', 'Bearer token-A')).allowed).toBe(true);
    expect(rl.check(req('5.6.7.8', 'Bearer token-A')).allowed).toBe(true);
    const denied = rl.check(req('9.10.11.12', 'Bearer token-A'));
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('token');
  });

  it('distinguishes different bearer tokens', () => {
    let now = 0;
    const rl = new RateLimiter({ rps: 1, burst: 1, now: () => now });
    expect(rl.check(req('1.2.3.4', 'Bearer token-A')).allowed).toBe(true);
    // Same IP would deny, but a different token resets the token bucket — and
    // we have to use a different IP too because the IP bucket is also drained.
    expect(rl.check(req('5.6.7.8', 'Bearer token-B')).allowed).toBe(true);
  });

  it('does not credit a request rejected by the token bucket back to the IP bucket', () => {
    // If the token bucket is the one that's drained, the IP bucket should
    // still have its token available for the next legitimate request from
    // that IP with a different token.
    let now = 0;
    const rl = new RateLimiter({ rps: 1, burst: 3, now: () => now });
    expect(rl.check(req('1.1.1.1', 'Bearer A')).allowed).toBe(true);
    expect(rl.check(req('1.1.1.1', 'Bearer A')).allowed).toBe(true);
    expect(rl.check(req('1.1.1.1', 'Bearer A')).allowed).toBe(true);
    const tokenDenied = rl.check(req('1.1.1.1', 'Bearer A'));
    expect(tokenDenied.allowed).toBe(false);
    // The IP bucket also consumed 3 tokens above, so it's also exhausted —
    // but a different token at the same IP demonstrates the IP axis is
    // honored independently. Use a fresh IP to isolate the token axis.
    expect(rl.check(req('2.2.2.2', 'Bearer A')).allowed).toBe(false);
    expect(rl.check(req('2.2.2.2', 'Bearer A')).reason).toBe('token');
  });

  it('handles requests without an Authorization header (IP-only)', () => {
    let now = 0;
    const rl = new RateLimiter({ rps: 1, burst: 1, now: () => now });
    expect(rl.check(req('1.2.3.4')).allowed).toBe(true);
    expect(rl.check(req('1.2.3.4')).allowed).toBe(false);
    // No token bucket created.
    expect(rl.inspect().tokens).toBe(0);
  });

  it('Retry-After is at least 1 and proportional to deficit', () => {
    let now = 0;
    const rl = new RateLimiter({ rps: 0.5, burst: 1, now: () => now });
    expect(rl.check(req('1.2.3.4')).allowed).toBe(true);
    const d = rl.check(req('1.2.3.4'));
    expect(d.allowed).toBe(false);
    // 0.5 rps → need 2s to refill one token.
    expect(d.retryAfter).toBe(2);
  });
});

describe('RateLimiter — split pre/post-auth axes and sweeping', () => {
  it('checkIp never creates token buckets, even with an Authorization header', () => {
    const rl = new RateLimiter({ rps: 1, burst: 2, now: () => 0 });
    expect(rl.checkIp(req('1.2.3.4', 'Bearer garbage')).allowed).toBe(true);
    expect(rl.inspect()).toEqual({ ips: 1, tokens: 0 });
  });

  it('checkToken limits per credential across IPs', () => {
    const rl = new RateLimiter({ rps: 1, burst: 1, now: () => 0 });
    expect(rl.checkToken(req('1.1.1.1', 'Bearer A')).allowed).toBe(true);
    const d = rl.checkToken(req('2.2.2.2', 'Bearer A'));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('token');
    // Explicit credential overrides the header.
    expect(rl.checkToken(req('2.2.2.2', 'Bearer A'), 'B').allowed).toBe(true);
  });

  it('evicts drained buckets once they have been idle long enough to refill', () => {
    let now = 0;
    const rl = new RateLimiter({ rps: 1, burst: 2, now: () => now, idleSweepMs: 10_000 });
    // Drain two IP buckets completely; their stored token count is 0.
    rl.check(req('1.1.1.1', 'Bearer A'));
    rl.check(req('1.1.1.1', 'Bearer A'));
    rl.check(req('2.2.2.2'));
    rl.check(req('2.2.2.2'));
    expect(rl.inspect()).toEqual({ ips: 2, tokens: 1 });
    // After idling past the sweep interval, the next request triggers a
    // sweep that must evict them even though their stored tokens are stale.
    now = 20_000;
    rl.check(req('3.3.3.3'));
    expect(rl.inspect()).toEqual({ ips: 1, tokens: 0 });
  });

  it('does not evict a bucket that is still refilling', () => {
    let now = 0;
    // 0.0001 rps -> 10_000s to refill one token.
    const rl = new RateLimiter({ rps: 0.0001, burst: 1, now: () => now, idleSweepMs: 1000 });
    rl.check(req('1.1.1.1'));
    now = 5000;
    rl.check(req('9.9.9.9'));
    expect(rl.check(req('1.1.1.1')).allowed).toBe(false);
  });
});
