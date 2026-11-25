import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  assertUrlIsSafe,
  checkConnectTarget,
  createGuardedFetch,
  createGuardedLookup,
  findUrlGuardError,
  hostMatchesAllowlist,
  isPrivateAddress,
  UrlGuardError,
  type BaseLookup,
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
    ['::ffff:7f00:1'], // IPv4-mapped loopback, hex form (what URL() normalizes to)
    ['::127.0.0.1'], // IPv4-compatible loopback
    ['64:ff9b::a00:1'], // NAT64 -> 10.0.0.1
    ['64:ff9b::127.0.0.1'], // NAT64 -> loopback
    ['64:ff9b:1::1'], // local-use NAT64
    ['2002:7f00:1::1'], // 6to4 embedding 127.0.0.1
    ['2002:a9fe:a9fe::1'], // 6to4 embedding 169.254.169.254
    ['2001::1'], // Teredo
    ['2001:db8::1'], // documentation
    ['fec0::1'], // deprecated site-local
    ['198.18.0.1'], // benchmarking
    ['198.19.255.255'], // benchmarking
    ['192.0.2.1'], // TEST-NET-1
    ['198.51.100.7'], // TEST-NET-2
    ['203.0.113.9'], // TEST-NET-3
    ['100.127.255.255'], // CGNAT upper edge
    ['[::1]'], // bracketed literal
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
    ['::ffff:8.8.8.8'], // IPv4-mapped public
    ['::ffff:808:808'], // IPv4-mapped public, hex form
    ['64:ff9b::808:808'], // NAT64 -> 8.8.8.8
    ['2002:808:808::1'], // 6to4 embedding 8.8.8.8
    ['198.20.0.1'], // just above 198.18/15
    ['100.128.0.1'], // just above CGNAT
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

describe('assertUrlIsSafe error messages', () => {
  it('does not echo the resolved address in the client-facing message', async () => {
    const err = await assertUrlIsSafe('http://169.254.169.254/x', {
      allowlist: [],
      allowPrivate: false,
    }).catch((e: unknown) => e as UrlGuardError);
    expect(err).toBeInstanceOf(UrlGuardError);
    expect((err as UrlGuardError).detail).toContain('169.254.169.254');
    // The host is the literal here, so check a hostname-based case too.
    expect((err as UrlGuardError).message).not.toContain('->');
  });
});

describe('checkConnectTarget', () => {
  it('blocks private addresses by default', () => {
    expect(
      checkConnectTarget('evil.example', '10.0.0.5', { allowlist: [], allowPrivate: false })
    ).toBeInstanceOf(UrlGuardError);
  });
  it('allows private when allowPrivate', () => {
    expect(
      checkConnectTarget('evil.example', '10.0.0.5', { allowlist: [], allowPrivate: true })
    ).toBeNull();
  });
  it('allowlisted host may resolve anywhere; others are refused', () => {
    const opts = { allowlist: ['example.com'], allowPrivate: false };
    expect(checkConnectTarget('a.example.com', '10.0.0.5', opts)).toBeNull();
    expect(checkConnectTarget('other.net', '8.8.8.8', opts)?.reason).toBe('not_allowlisted');
  });
});

describe('createGuardedLookup (connect-time DNS check)', () => {
  function fakeResolver(addresses: Array<{ address: string; family: number }>): BaseLookup {
    return (_host, _opts, cb) => cb(null, addresses);
  }

  function run(
    lookup: ReturnType<typeof createGuardedLookup>,
    all: boolean
  ): Promise<{ err: unknown; result: unknown[] }> {
    return new Promise((resolve) => {
      (lookup as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void)(
        'rebind.example',
        { all },
        (err: unknown, ...result: unknown[]) => resolve({ err, result })
      );
    });
  }

  it('rejects when the name resolves to a private address (DNS rebinding)', async () => {
    const lookup = createGuardedLookup(
      { allowlist: [], allowPrivate: false },
      fakeResolver([{ address: '127.0.0.1', family: 4 }])
    );
    const { err } = await run(lookup, true);
    expect(err).toBeInstanceOf(UrlGuardError);
    expect((err as UrlGuardError).reason).toBe('private_address');
  });

  it('rejects if ANY returned address is private', async () => {
    const lookup = createGuardedLookup(
      { allowlist: [], allowPrivate: false },
      fakeResolver([
        { address: '8.8.8.8', family: 4 },
        { address: '::ffff:169.254.169.254', family: 6 },
      ])
    );
    const { err } = await run(lookup, true);
    expect(err).toBeInstanceOf(UrlGuardError);
  });

  it('passes public addresses through in both all and single modes', async () => {
    const lookup = createGuardedLookup(
      { allowlist: [], allowPrivate: false },
      fakeResolver([{ address: '8.8.8.8', family: 4 }])
    );
    const all = await run(lookup, true);
    expect(all.err).toBeNull();
    expect(all.result[0]).toEqual([{ address: '8.8.8.8', family: 4 }]);
    const single = await run(lookup, false);
    expect(single.err).toBeNull();
    expect(single.result).toEqual(['8.8.8.8', 4]);
  });

  it('respects allowPrivate', async () => {
    const lookup = createGuardedLookup(
      { allowlist: [], allowPrivate: true },
      fakeResolver([{ address: '10.1.2.3', family: 4 }])
    );
    expect((await run(lookup, true)).err).toBeNull();
  });
});

describe('createGuardedFetch', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  async function startLocal(): Promise<number> {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return (server!.address() as AddressInfo).port;
  }

  it('refuses to connect to a loopback IP literal when private is disallowed', async () => {
    const port = await startLocal();
    const f = createGuardedFetch({ allowlist: [], allowPrivate: false });
    const err = await f(`http://127.0.0.1:${port}/`).catch((e: unknown) => e);
    expect(findUrlGuardError(err)?.reason).toBe('private_address');
  });

  it('refuses a hostname that resolves to loopback at connect time', async () => {
    const port = await startLocal();
    const f = createGuardedFetch(
      { allowlist: [], allowPrivate: false },
      { baseLookup: (_h, _o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]) }
    );
    const err = await f(`http://public.example:${port}/`).catch((e: unknown) => e);
    expect(findUrlGuardError(err)?.reason).toBe('private_address');
  });

  it('connects when allowed, and defaults to redirect: manual', async () => {
    const port = await startLocal();
    const f = createGuardedFetch({ allowlist: [], allowPrivate: true });
    const ok = await f(`http://127.0.0.1:${port}/`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('ok');
    const redirect = await f(`http://127.0.0.1:${port}/redirect`);
    expect(redirect.status).toBe(302);
    await redirect.body?.cancel();
  });

  it('enforces the allowlist at connect time', async () => {
    const port = await startLocal();
    const f = createGuardedFetch({ allowlist: ['example.com'], allowPrivate: false });
    const err = await f(`http://127.0.0.1:${port}/`).catch((e: unknown) => e);
    expect(findUrlGuardError(err)?.reason).toBe('not_allowlisted');
  });
});
