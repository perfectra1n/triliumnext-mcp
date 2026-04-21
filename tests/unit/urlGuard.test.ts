import { describe, it, expect } from 'vitest';
import {
  assertUrlIsSafe,
  hostMatchesAllowlist,
  isPrivateAddress,
  UrlGuardError,
} from '../../src/http/urlGuard.js';

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1'],
    ['127.5.5.5'],
    ['10.0.0.1'],
    ['10.255.255.255'],
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['192.168.1.1'],
    ['169.254.169.254'], // AWS IMDS
    ['0.0.0.0'],
    ['100.64.0.1'], // CGNAT
    ['224.0.0.1'], // multicast
    ['255.255.255.255'],
    ['::1'],
    ['::'],
    ['fe80::1'], // link-local v6
    ['fd12:3456::1'], // ULA
    ['fc00::1'], // ULA
    ['ff02::1'], // multicast v6
    ['::ffff:127.0.0.1'], // IPv4-mapped loopback
    ['::ffff:10.0.0.1'], // IPv4-mapped private
  ])('flags %s as private', (addr) => {
    expect(isPrivateAddress(addr)).toBe(true);
  });

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['93.184.216.34'], // example.com
    ['172.15.0.1'], // just below 172.16/12
    ['172.32.0.1'], // just above 172.16/12
    ['192.167.1.1'],
    ['192.169.1.1'],
    ['2606:4700:4700::1111'], // Cloudflare v6
    ['2001:db8::1'],
  ])('does not flag %s', (addr) => {
    expect(isPrivateAddress(addr)).toBe(false);
  });

  it('treats non-IP strings as unsafe', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('hostMatchesAllowlist', () => {
  it('matches exact host', () => {
    expect(hostMatchesAllowlist('example.com', ['example.com'])).toBe(true);
  });

  it('matches subdomain via suffix', () => {
    expect(hostMatchesAllowlist('a.example.com', ['example.com'])).toBe(true);
    expect(hostMatchesAllowlist('a.b.example.com', ['example.com'])).toBe(true);
  });

  it('does NOT match unrelated host with similar suffix', () => {
    expect(hostMatchesAllowlist('fakeexample.com', ['example.com'])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hostMatchesAllowlist('Example.COM', ['example.com'])).toBe(true);
    expect(hostMatchesAllowlist('a.EXAMPLE.com', ['example.COM'])).toBe(true);
  });

  it('checks every allowlist entry', () => {
    expect(hostMatchesAllowlist('b.other.com', ['example.com', 'other.com'])).toBe(true);
  });

  it('returns false for empty allowlist', () => {
    expect(hostMatchesAllowlist('example.com', [])).toBe(false);
  });
});

describe('assertUrlIsSafe', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(
      assertUrlIsSafe('file:///etc/passwd', { allowlist: [], allowPrivate: true })
    ).rejects.toThrow(UrlGuardError);
  });

  it('rejects URLs with embedded credentials', async () => {
    await expect(
      assertUrlIsSafe('http://user:pass@example.com/', { allowlist: [], allowPrivate: true })
    ).rejects.toMatchObject({ reason: 'embedded_credentials' });
  });

  it('rejects unparseable URLs', async () => {
    await expect(
      assertUrlIsSafe('not a url', { allowlist: [], allowPrivate: true })
    ).rejects.toThrow(UrlGuardError);
  });

  it('rejects IP literal in private range', async () => {
    await expect(
      assertUrlIsSafe('http://169.254.169.254/latest/meta-data', {
        allowlist: [],
        allowPrivate: false,
      })
    ).rejects.toMatchObject({ reason: 'private_address' });
  });

  it('accepts public IP literal', async () => {
    await expect(
      assertUrlIsSafe('http://8.8.8.8/', { allowlist: [], allowPrivate: false })
    ).resolves.toBeUndefined();
  });

  it('allowlist bypasses private-IP block', async () => {
    await expect(
      assertUrlIsSafe('http://127.0.0.1:8080/', {
        allowlist: ['127.0.0.1'],
        allowPrivate: false,
      })
    ).resolves.toBeUndefined();
  });

  it('rejects host not in allowlist', async () => {
    await expect(
      assertUrlIsSafe('http://8.8.8.8/', {
        allowlist: ['example.com'],
        allowPrivate: true,
      })
    ).rejects.toMatchObject({ reason: 'not_allowlisted' });
  });

  it('allowPrivate skips the private-IP check', async () => {
    await expect(
      assertUrlIsSafe('http://192.168.1.1:8080/', {
        allowlist: [],
        allowPrivate: true,
      })
    ).resolves.toBeUndefined();
  });
});
