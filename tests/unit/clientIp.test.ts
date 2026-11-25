import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  addressKey,
  parseCidr,
  parseIp,
  resolveClientIp,
  TrustedProxies,
} from '../../src/http/clientIp.js';

function req(remoteAddress: string, xff?: string | string[]): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  } as unknown as IncomingMessage;
}

describe('parseIp / parseCidr', () => {
  it('folds IPv4-mapped IPv6 to IPv4', () => {
    expect(parseIp('::ffff:10.1.2.3')).toEqual(parseIp('10.1.2.3'));
    expect(parseIp('[::1]')?.family).toBe(6);
    expect(parseIp('not-an-ip')).toBeNull();
    expect(parseIp('256.1.1.1')).toBeNull();
  });

  it.each(['10.0.0.0/8', '172.16.0.1', 'fd00::/8', '::1', '0.0.0.0/0', '::ffff:10.0.0.0/104'])(
    'accepts %s',
    (c) => expect(parseCidr(c)).not.toBeNull()
  );

  it.each(['10.0.0.0/33', 'fd00::/129', 'proxy.local', '10.0.0.0/8/1', '10.0.0.0/x', ''])(
    'rejects %s',
    (c) => expect(parseCidr(c)).toBeNull()
  );
});

describe('TrustedProxies', () => {
  it('matches addresses inside configured CIDRs, across v4-mapped forms', () => {
    const t = new TrustedProxies(['10.0.0.0/8', 'fd00::/8', '192.168.1.1']);
    expect(t.has('10.200.3.4')).toBe(true);
    expect(t.has('::ffff:10.200.3.4')).toBe(true);
    expect(t.has('fd12::1')).toBe(true);
    expect(t.has('192.168.1.1')).toBe(true);
    expect(t.has('192.168.1.2')).toBe(false);
    expect(t.has('11.0.0.1')).toBe(false);
    expect(t.has('garbage')).toBe(false);
  });

  it('throws on a malformed entry', () => {
    expect(() => new TrustedProxies(['nope'])).toThrow(/nope/);
  });
});

describe('resolveClientIp', () => {
  const trusted = new TrustedProxies(['10.0.0.0/8']);

  it('uses the socket peer when no proxy is trusted, ignoring X-Forwarded-For', () => {
    expect(resolveClientIp(req('203.0.113.9', '1.2.3.4'), new TrustedProxies())).toBe(
      '203.0.113.9'
    );
  });

  it('uses the socket peer when the peer is not a trusted proxy', () => {
    expect(resolveClientIp(req('203.0.113.9', '1.2.3.4'), trusted)).toBe('203.0.113.9');
  });

  it('takes the right-most untrusted hop behind trusted proxies', () => {
    // client-spoofed, real client, inner proxy
    expect(resolveClientIp(req('10.0.0.2', '6.6.6.6, 198.51.100.7, 10.0.0.1'), trusted)).toBe(
      '198.51.100.7'
    );
    // Multiple header lines are concatenated in order.
    expect(resolveClientIp(req('10.0.0.2', ['6.6.6.6', '198.51.100.7']), trusted)).toBe(
      '198.51.100.7'
    );
  });

  it('falls back to the peer for a malformed hop or a missing header', () => {
    expect(resolveClientIp(req('10.0.0.2', 'garbage'), trusted)).toBe('10.0.0.2');
    expect(resolveClientIp(req('10.0.0.2'), trusted)).toBe('10.0.0.2');
  });

  it('uses the left-most hop when every hop is trusted', () => {
    expect(resolveClientIp(req('10.0.0.2', '10.0.0.5, 10.0.0.1'), trusted)).toBe('10.0.0.5');
  });
});

describe('addressKey', () => {
  it('keeps IPv4 and collapses IPv6 to its /64', () => {
    expect(addressKey('203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('2001:db8:1:2:aaaa::1')).toBe(addressKey('2001:db8:1:2:bbbb::2'));
    expect(addressKey('2001:db8:1:2::1')).not.toBe(addressKey('2001:db8:1:3::1'));
    expect(addressKey('2001:db8:1:2::1')).toBe('2001:db8:1:2:0:0:0:0/64');
    expect(addressKey('unknown')).toBe('unknown');
  });
});
