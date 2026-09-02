import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  resolveContentInput,
  ContentNormalizationError,
  parseDataUrl,
  decodeBase64Strict,
  type ContentInputPolicy,
} from '../../src/tools/contentInput.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid PNG: signature + IHDR (1x1) + IEND. file-type sniffs it as image/png. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length + type
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, // bit depth, color, CRC
  0x89,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, // IEND
  0xae, 0x42, 0x60, 0x82,
]);

/** JPEG header — its base64 starts with "/9j/", the classic path-lookalike. */
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

const PNG_B64 = PNG_BYTES.toString('base64');
const JPEG_B64 = JPEG_BYTES.toString('base64');

/** Permissive stdio-like policy for tests; individual tests override fields. */
function policy(overrides: Partial<ContentInputPolicy> = {}): ContentInputPolicy {
  return {
    allowLocalFileRead: true,
    localFileRoots: [],
    urlGuard: { allowlist: [], allowPrivate: true },
    maxBytes: 50 * 1024 * 1024,
    fetchTimeoutMs: 5000,
    ...overrides,
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function makeTempDir(base = tmpdir()): Promise<string> {
  const dir = await mkdtemp(join(base, 'trilium-mcp-ci-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeTempFile(name: string, content: Buffer | string, base?: string) {
  const dir = await makeTempDir(base);
  const path = join(dir, name);
  await writeFile(path, content);
  return { dir, path };
}

function startServer(
  handler: Parameters<typeof createServer>[1]
): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      cleanups.push(() => new Promise((r) => server.close(() => r())));
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

async function expectError(
  promise: Promise<unknown>,
  code: string
): Promise<ContentNormalizationError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ContentNormalizationError);
    expect((err as ContentNormalizationError).code).toBe(code);
    return err as ContentNormalizationError;
  }
  throw new Error(`expected ContentNormalizationError(${code}) but nothing was thrown`);
}

// ---------------------------------------------------------------------------
// parseDataUrl
// ---------------------------------------------------------------------------

describe('parseDataUrl', () => {
  it('parses the base64 form', () => {
    const parsed = parseDataUrl(`data:image/png;base64,${PNG_B64}`);
    expect(parsed).not.toBeNull();
    expect(parsed!.mime).toBe('image/png');
    expect(parsed!.buffer.equals(PNG_BYTES)).toBe(true);
  });

  it('parses the non-base64 percent-encoded form', () => {
    const parsed = parseDataUrl('data:text/plain,hello%20world');
    expect(parsed).not.toBeNull();
    expect(parsed!.mime).toBe('text/plain');
    expect(parsed!.buffer.toString('utf8')).toBe('hello world');
  });

  it('defaults the mime to text/plain when omitted', () => {
    const parsed = parseDataUrl('data:,hi');
    expect(parsed!.mime).toBe('text/plain');
    expect(parsed!.buffer.toString('utf8')).toBe('hi');
  });

  it('strips mediatype parameters like charset', () => {
    const parsed = parseDataUrl('data:text/plain;charset=utf-8,hi');
    expect(parsed!.mime).toBe('text/plain');
  });

  it('returns null for non-data-URL strings', () => {
    expect(parseDataUrl('hello')).toBeNull();
    expect(parseDataUrl('/tmp/foo.png')).toBeNull();
    expect(parseDataUrl('https://example.com/a.png')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decodeBase64Strict
// ---------------------------------------------------------------------------

describe('decodeBase64Strict', () => {
  it('decodes valid base64', () => {
    expect(decodeBase64Strict(PNG_B64)!.equals(PNG_BYTES)).toBe(true);
  });

  it('tolerates whitespace and newlines (common in LLM output)', () => {
    const wrapped = PNG_B64.replace(/(.{20})/g, '$1\n');
    expect(decodeBase64Strict(wrapped)!.equals(PNG_BYTES)).toBe(true);
  });

  it('returns null for invalid characters', () => {
    expect(decodeBase64Strict('not valid base64!!!')).toBeNull();
  });

  it('returns null for wrong padding length', () => {
    expect(decodeBase64Strict('abcde')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inline content (backward-compatible paths)
// ---------------------------------------------------------------------------

describe('resolveContentInput: inline', () => {
  it('decodes base64 when mime is binary (today’s behavior)', async () => {
    const res = await resolveContentInput(PNG_B64, { mime: 'image/png' }, policy());
    expect(res.origin).toBe('inline-base64');
    expect(res.mime).toBe('image/png');
    expect(res.isBinary).toBe(true);
    expect(res.buffer.equals(PNG_BYTES)).toBe(true);
  });

  it('treats JPEG base64 starting with /9j/ as base64, never as a path', async () => {
    const res = await resolveContentInput(JPEG_B64, { mime: 'image/jpeg' }, policy());
    expect(res.origin).toBe('inline-base64');
    expect(res.buffer.equals(JPEG_BYTES)).toBe(true);
  });

  it('keeps raw text verbatim for text mimes, even when it looks like base64', async () => {
    const prose = 'Deadbeef'; // valid base64 alphabet, but text mime means verbatim
    const res = await resolveContentInput(prose, { mime: 'text/plain' }, policy());
    expect(res.origin).toBe('inline-text');
    expect(res.isBinary).toBe(false);
    expect(res.buffer.toString('utf8')).toBe(prose);
  });

  it('keeps path-shaped raw text verbatim for text mimes when no such file exists', async () => {
    const prose = '/etc/some/path/mentioned/in/a/note.txt';
    const res = await resolveContentInput(prose, { mime: 'text/plain' }, policy());
    expect(res.origin).toBe('inline-text');
    expect(res.buffer.toString('utf8')).toBe(prose);
  });

  it('rejects invalid base64 for binary mimes instead of silently corrupting', async () => {
    await expectError(
      resolveContentInput('this is definitely not base64!!!', { mime: 'image/png' }, policy()),
      'INVALID_BASE64'
    );
  });

  it('sniffs binary type from base64 when no mime is given', async () => {
    const res = await resolveContentInput(PNG_B64, {}, policy());
    expect(res.origin).toBe('inline-base64');
    expect(res.mime).toBe('image/png');
  });

  it('resolves text mime from the filename extension when no mime is given', async () => {
    const res = await resolveContentInput('a,b\n1,2\n', { filename: 'data.csv' }, policy());
    expect(res.origin).toBe('inline-text');
    expect(res.mime).toBe('text/csv');
    expect(res.buffer.toString('utf8')).toBe('a,b\n1,2\n');
  });

  it('errors on undetectable inline input with no mime (no text/plain guess)', async () => {
    await expectError(
      resolveContentInput('hello world, this is prose', {}, policy()),
      'UNDETECTABLE_MIME'
    );
  });

  it('errors on base64-decodable but unsniffable input with no mime', async () => {
    // "abcd1234" is valid base64 but decodes to unidentifiable bytes — must not
    // silently store garbage as a binary blob.
    await expectError(resolveContentInput('abcd1234', {}, policy()), 'UNDETECTABLE_MIME');
  });
});

// ---------------------------------------------------------------------------
// Data URLs
// ---------------------------------------------------------------------------

describe('resolveContentInput: data URLs', () => {
  it('extracts bytes and mime, overriding the explicit mime hint', async () => {
    const res = await resolveContentInput(
      `data:image/png;base64,${PNG_B64}`,
      { mime: 'image/jpeg' },
      policy()
    );
    expect(res.origin).toBe('data-url');
    expect(res.mime).toBe('image/png');
    expect(res.buffer.equals(PNG_BYTES)).toBe(true);
  });

  it('supports the non-base64 form', async () => {
    const res = await resolveContentInput('data:text/plain,hello%20world', {}, policy());
    expect(res.origin).toBe('data-url');
    expect(res.mime).toBe('text/plain');
    expect(res.isBinary).toBe(false);
    expect(res.buffer.toString('utf8')).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// Local file paths
// ---------------------------------------------------------------------------

describe('resolveContentInput: local paths', () => {
  it('reads an absolute path and sniffs the mime from magic bytes', async () => {
    const { path } = await makeTempFile('shot.png', PNG_BYTES);
    const res = await resolveContentInput(path, {}, policy());
    expect(res.origin).toBe('path');
    expect(res.mime).toBe('image/png');
    expect(res.isBinary).toBe(true);
    expect(res.buffer.equals(PNG_BYTES)).toBe(true);
    expect(res.sourceName).toBe('shot.png');
  });

  it('sniff beats a misleading file extension', async () => {
    const { path } = await makeTempFile('actually-a-png.txt', PNG_BYTES);
    const res = await resolveContentInput(path, {}, policy());
    expect(res.mime).toBe('image/png');
  });

  it('an explicit mime hint beats the sniff', async () => {
    const { path } = await makeTempFile('img.png', PNG_BYTES);
    const res = await resolveContentInput(path, { mime: 'image/webp' }, policy());
    expect(res.mime).toBe('image/webp');
  });

  it('reads a text file (text mime resolution via extension)', async () => {
    const { path } = await makeTempFile('data.csv', 'a,b\n1,2\n');
    const res = await resolveContentInput(path, {}, policy());
    expect(res.origin).toBe('path');
    expect(res.mime).toBe('text/csv');
    expect(res.isBinary).toBe(false);
    expect(res.buffer.toString('utf8')).toBe('a,b\n1,2\n');
  });

  it('detects SVG content as image/svg+xml (file-type cannot sniff SVG)', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const { path } = await makeTempFile('icon.svg', svg);
    const res = await resolveContentInput(path, {}, policy());
    expect(res.mime).toBe('image/svg+xml');
    expect(res.isBinary).toBe(false); // Trilium stores SVG as text
  });

  it('falls back to text/plain for extension-less UTF-8 text files', async () => {
    const { path } = await makeTempFile('README', 'just some notes\n');
    const res = await resolveContentInput(path, {}, policy());
    expect(res.mime).toBe('text/plain');
  });

  it('falls back to application/octet-stream for unidentifiable binary files', async () => {
    const { path } = await makeTempFile('mystery.bin', Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80]));
    const res = await resolveContentInput(path, {}, policy());
    expect(res.mime).toBe('application/octet-stream');
    expect(res.isBinary).toBe(true);
  });

  it('supports the file:// prefix as an explicit path discriminator', async () => {
    const { path } = await makeTempFile('shot.png', PNG_BYTES);
    const res = await resolveContentInput(`file://${path}`, {}, policy());
    expect(res.origin).toBe('path');
    expect(res.buffer.equals(PNG_BYTES)).toBe(true);
  });

  it('file:// with a nonexistent path fails with PATH_NOT_FOUND (no fallthrough)', async () => {
    await expectError(
      resolveContentInput('file:///nonexistent/nope.png', {}, policy()),
      'PATH_NOT_FOUND'
    );
  });

  it('expands ~/ against the home directory', async () => {
    const dir = await makeTempDir(homedir());
    const path = join(dir, 'home.png');
    await writeFile(path, PNG_BYTES);
    const tilde = `~/${join(basename(dir), 'home.png')}`;
    const res = await resolveContentInput(tilde, {}, policy());
    expect(res.origin).toBe('path');
    expect(res.buffer.equals(PNG_BYTES)).toBe(true);
  });

  it('mentions the path when path-shaped binary input does not exist on disk', async () => {
    const err = await expectError(
      resolveContentInput('/nonexistent/dir/shot.png', { mime: 'image/png' }, policy()),
      'PATH_NOT_FOUND'
    );
    expect(err.message).toContain('/nonexistent/dir/shot.png');
  });

  it('refuses path reads when allowLocalFileRead is false', async () => {
    const { path } = await makeTempFile('secret.png', PNG_BYTES);
    await expectError(
      resolveContentInput(path, {}, policy({ allowLocalFileRead: false })),
      'PATH_NOT_PERMITTED'
    );
  });

  it('refuses paths outside localFileRoots', async () => {
    const root = await makeTempDir();
    const { path: outside } = await makeTempFile('out.png', PNG_BYTES);
    await expectError(
      resolveContentInput(outside, {}, policy({ localFileRoots: [root] })),
      'PATH_NOT_PERMITTED'
    );
  });

  it('allows paths inside localFileRoots', async () => {
    const root = await makeTempDir();
    const path = join(root, 'in.png');
    await writeFile(path, PNG_BYTES);
    const res = await resolveContentInput(path, {}, policy({ localFileRoots: [root] }));
    expect(res.buffer.equals(PNG_BYTES)).toBe(true);
  });

  it('resolves symlinks before the root check so links cannot escape the sandbox', async () => {
    const root = await makeTempDir();
    const { path: outside } = await makeTempFile('target.png', PNG_BYTES);
    const link = join(root, 'sneaky.png');
    await symlink(outside, link);
    await expectError(
      resolveContentInput(link, {}, policy({ localFileRoots: [root] })),
      'PATH_NOT_PERMITTED'
    );
  });

  it('rejects files larger than maxBytes', async () => {
    const { path } = await makeTempFile('big.bin', Buffer.alloc(2048));
    await expectError(
      resolveContentInput(path, {}, policy({ maxBytes: 1024 })),
      'INPUT_TOO_LARGE'
    );
  });
});

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

describe('resolveContentInput: URLs', () => {
  it('fetches bytes and sniffs the mime', async () => {
    const { origin } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(PNG_BYTES);
    });
    const res = await resolveContentInput(`${origin}/img.png?v=2`, {}, policy());
    expect(res.origin).toBe('url');
    expect(res.mime).toBe('image/png');
    expect(res.buffer.equals(PNG_BYTES)).toBe(true);
    expect(res.sourceName).toBe('img.png');
  });

  it('sniff beats a wrong Content-Type header', async () => {
    const { origin } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(PNG_BYTES);
    });
    const res = await resolveContentInput(`${origin}/x`, {}, policy());
    expect(res.mime).toBe('image/png');
  });

  it('uses the response Content-Type when sniffing fails', async () => {
    const { origin } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
      res.end('a,b\n1,2\n');
    });
    const res = await resolveContentInput(`${origin}/export`, {}, policy());
    expect(res.mime).toBe('text/csv');
    expect(res.isBinary).toBe(false);
  });

  it('follows redirects, re-guarding each hop', async () => {
    const { origin } = await startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: `${origin}/final.png` });
        res.end();
      } else {
        res.writeHead(200);
        res.end(PNG_BYTES);
      }
    });
    const res = await resolveContentInput(`${origin}/start`, {}, policy());
    expect(res.buffer.equals(PNG_BYTES)).toBe(true);
  });

  it('blocks a redirect to a host outside the allowlist', async () => {
    const { origin } = await startServer((req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.2:9/steal' });
      res.end();
    });
    await expectError(
      resolveContentInput(
        `${origin}/start`,
        {},
        policy({ urlGuard: { allowlist: ['127.0.0.1'], allowPrivate: false } })
      ),
      'URL_BLOCKED'
    );
  });

  it('blocks private hosts when allowPrivate is false', async () => {
    await expectError(
      resolveContentInput(
        'http://127.0.0.1:1/x.png',
        {},
        policy({ urlGuard: { allowlist: [], allowPrivate: false } })
      ),
      'URL_BLOCKED'
    );
  });

  it('fails on non-2xx responses', async () => {
    const { origin } = await startServer((req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    await expectError(resolveContentInput(`${origin}/missing.png`, {}, policy()), 'URL_FETCH_FAILED');
  });

  it('fails after too many redirects', async () => {
    const { origin } = await startServer((req, res) => {
      res.writeHead(302, { Location: `${origin}/loop` });
      res.end();
    });
    await expectError(resolveContentInput(`${origin}/loop`, {}, policy()), 'URL_FETCH_FAILED');
  });

  it('rejects oversized downloads via Content-Length up front', async () => {
    const { origin } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Length': String(10 * 1024) });
      res.end(Buffer.alloc(10 * 1024));
    });
    await expectError(
      resolveContentInput(`${origin}/big.bin`, {}, policy({ maxBytes: 1024 })),
      'INPUT_TOO_LARGE'
    );
  });

  it('aborts oversized chunked downloads that hide their length', async () => {
    const { origin } = await startServer((req, res) => {
      // No Content-Length -> chunked; stream forever-ish
      res.writeHead(200);
      const chunk = Buffer.alloc(1024);
      for (let i = 0; i < 64; i++) res.write(chunk);
      res.end();
    });
    await expectError(
      resolveContentInput(`${origin}/stream.bin`, {}, policy({ maxBytes: 4 * 1024 })),
      'INPUT_TOO_LARGE'
    );
  });

  it('an explicit mime hint beats everything for URLs too', async () => {
    const { origin } = await startServer((req, res) => {
      res.writeHead(200);
      res.end(PNG_BYTES);
    });
    const res = await resolveContentInput(`${origin}/img`, { mime: 'image/webp' }, policy());
    expect(res.mime).toBe('image/webp');
  });
});
