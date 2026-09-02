import { promises as fs } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, sep } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { assertUrlIsSafe, UrlGuardError } from '../http/urlGuard.js';

// ============================================================================
// MIME helpers (moved here from attachments.ts so both attachments.ts and
// notes.ts can import them without a cycle; attachments.ts re-exports them)
// ============================================================================

export const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

export function isImageMimeType(mime: string): boolean {
  return IMAGE_MIME_TYPES.has(mime.toLowerCase());
}

/**
 * MIME types that TriliumNext treats as text (string) content.
 * Mirrors TriliumNext's isStringNote() logic in services/utils.ts.
 */
const TEXT_MIME_EXACT = new Set([
  'application/javascript',
  'application/x-javascript',
  'application/json',
  'application/x-sql',
  'image/svg+xml',
]);

export function isBinaryMimeType(mime: string): boolean {
  const lower = mime.toLowerCase();
  if (lower.startsWith('text/')) return false;
  if (TEXT_MIME_EXACT.has(lower)) return false;
  return true;
}

/**
 * Shared schema-description text for every content-carrying field. This is the
 * LLM's UX for the feature — keep it in sync with resolveContentInput.
 */
export const CONTENT_SOURCE_GUIDANCE =
  'Pass any of: a local file path ("/abs/path" or "~/path"), an http(s) URL, a data URL ' +
  '(data:image/png;base64,...), or inline base64 (binary types) / raw text (text types) — ' +
  'the source is auto-detected. Use a file:// prefix to force path interpretation.';

// ============================================================================
// Errors
// ============================================================================

export type ContentNormalizationCode =
  | 'PATH_NOT_FOUND'
  | 'PATH_NOT_PERMITTED'
  | 'INPUT_TOO_LARGE'
  | 'URL_BLOCKED'
  | 'URL_FETCH_FAILED'
  | 'INVALID_BASE64'
  | 'UNDETECTABLE_MIME';

export class ContentNormalizationError extends Error {
  constructor(
    public readonly code: ContentNormalizationCode,
    message: string,
    public readonly suggestion: string
  ) {
    super(message);
    this.name = 'ContentNormalizationError';
  }
}

// ============================================================================
// Low-level parsers
// ============================================================================

/**
 * Strict base64 decoder. Returns null when the input is not valid base64
 * (Buffer.from(x, 'base64') silently skips invalid characters, which turns
 * typos into corrupted uploads). Whitespace is tolerated — LLMs often wrap
 * long base64 payloads.
 */
export function decodeBase64Strict(input: string): Buffer | null {
  const cleaned = input.replace(/\s+/g, '');
  if (cleaned.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
  return Buffer.from(cleaned, 'base64');
}

/**
 * Parse a data URL and extract the MIME type and decoded bytes. Handles both
 * the base64 form (data:image/png;base64,...) and the percent-encoded text
 * form (data:text/plain,hello%20world). Returns null if the string is not a
 * data URL; throws INVALID_BASE64 if it is one but its payload is corrupt.
 */
export function parseDataUrl(data: string): { mime: string; buffer: Buffer } | null {
  const match = data.match(/^data:([^,]*),([\s\S]*)$/);
  if (!match) return null;
  let mediatype = match[1];
  const payload = match[2];

  let isBase64 = false;
  if (/;base64$/i.test(mediatype)) {
    isBase64 = true;
    mediatype = mediatype.replace(/;base64$/i, '');
  }
  // Strip parameters (charset=...) and default per RFC 2397.
  const mime = mediatype.split(';')[0].trim() || 'text/plain';

  if (isBase64) {
    const buffer = decodeBase64Strict(payload);
    if (buffer === null) {
      throw new ContentNormalizationError(
        'INVALID_BASE64',
        'The data URL payload is not valid base64.',
        'Re-encode the content as base64, or pass a file path or http(s) URL instead.'
      );
    }
    return { mime, buffer };
  }

  let text: string;
  try {
    text = decodeURIComponent(payload);
  } catch {
    text = payload;
  }
  return { mime, buffer: Buffer.from(text, 'utf8') };
}

// ============================================================================
// Policy
// ============================================================================

export interface ContentInputPolicy {
  /** Permit reading LLM-supplied local file paths. */
  allowLocalFileRead: boolean;
  /** When non-empty, restrict path reads to these directories (realpath-checked). */
  localFileRoots: string[];
  /** SSRF guard options for http(s) content fetches. */
  urlGuard: { allowlist: string[]; allowPrivate: boolean };
  /** Maximum bytes for any file read or URL download. */
  maxBytes: number;
  /** Timeout for each URL fetch request. */
  fetchTimeoutMs: number;
}

const DEFAULT_POLICY: ContentInputPolicy = {
  allowLocalFileRead: true,
  localFileRoots: [],
  urlGuard: { allowlist: [], allowPrivate: false },
  maxBytes: 50 * 1024 * 1024,
  fetchTimeoutMs: 30_000,
};

let activePolicy: ContentInputPolicy = DEFAULT_POLICY;

/** Set the process-wide content-input policy. Called once at server startup. */
export function configureContentInput(policy: ContentInputPolicy): void {
  activePolicy = policy;
}

// ============================================================================
// Public API
// ============================================================================

export type ContentOrigin = 'inline-text' | 'inline-base64' | 'data-url' | 'path' | 'url';

export interface ResolvedContent {
  buffer: Buffer;
  mime: string;
  isBinary: boolean;
  origin: ContentOrigin;
  /** Basename of the source path/URL, usable as a default filename/title. */
  sourceName?: string;
}

export interface ContentHints {
  /** Explicit caller-provided MIME type; beats sniffing (but not a data-URL header). */
  mime?: string;
  /** Filename whose extension helps MIME resolution. */
  filename?: string;
}

/**
 * Resolve LLM-supplied content in any supported form — data URL, http(s) URL,
 * local file path (absolute, `~/`, or `file://`), inline base64, or raw text —
 * into bytes plus a resolved MIME type.
 *
 * Detection precedence: data: > http(s):// > file:// > existing absolute path >
 * inline. Path detection is verification-gated: a string only counts as a path
 * if it is short (≤1024 chars) AND names an existing regular file, so base64
 * payloads (JPEG base64 starts with "/9j/4AAQ...") and prose can never be
 * misread as paths.
 */
export async function resolveContentInput(
  raw: string,
  hints: ContentHints = {},
  policyOverride?: ContentInputPolicy
): Promise<ResolvedContent> {
  const policy = policyOverride ?? activePolicy;

  // 1. Data URL — unambiguous prefix.
  if (raw.startsWith('data:')) {
    const parsed = parseDataUrl(raw);
    if (parsed) {
      return finalize(parsed.buffer, 'data-url', { hints, resolvedMime: parsed.mime });
    }
  }

  // 2. http(s) URL — unambiguous prefix, must parse and contain no whitespace.
  if (/^https?:\/\//i.test(raw) && !/\s/.test(raw)) {
    const url = tryParseUrl(raw);
    if (url) return await fetchFromUrl(url, hints, policy);
  }

  // 3. file:// — the explicit "this is a path" discriminator: no fallthrough.
  if (raw.startsWith('file://')) {
    return await readFromPath(raw.slice('file://'.length), hints, policy, { explicit: true });
  }

  // 4. Plausible local path, verification-gated. The length cap and the
  //    stat-existence check below make base64 false-positives impossible:
  //    JPEG base64 starts with "/9j/4AAQ..." but is far longer than 1024
  //    chars for any real image, and never names an existing file.
  let pathCandidate: string | null = null;
  if (raw.length <= 1024 && /^(~\/|\/)[^\n\0]*$/.test(raw)) {
    const expanded = expandTilde(raw);
    const stats = await fs.stat(expanded).catch(() => null);
    if (stats?.isFile()) {
      return await readFromPath(raw, hints, policy, { explicit: false });
    }
    pathCandidate = raw;
  }

  // 5. Inline content (today's behavior, mime-driven).
  return await resolveInline(raw, hints, pathCandidate);
}

// ============================================================================
// Path reading
// ============================================================================

function expandTilde(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

async function readFromPath(
  rawPath: string,
  hints: ContentHints,
  policy: ContentInputPolicy,
  opts: { explicit: boolean }
): Promise<ResolvedContent> {
  if (!policy.allowLocalFileRead) {
    throw new ContentNormalizationError(
      'PATH_NOT_PERMITTED',
      `Local file reads are disabled on this server (input: ${rawPath}).`,
      'Pass the content inline as base64 or a data URL, use an http(s) URL, or start the server with --allow-local-file-read.'
    );
  }

  const expanded = expandTilde(rawPath);
  if (!isAbsolute(expanded)) {
    throw new ContentNormalizationError(
      'PATH_NOT_FOUND',
      `File paths must be absolute or start with ~/ (got: ${rawPath}).`,
      'Use an absolute path like /tmp/image.png or ~/Documents/image.png.'
    );
  }

  // Resolve symlinks BEFORE the roots check so a link inside an allowed root
  // cannot point outside the sandbox.
  let real: string;
  try {
    real = await fs.realpath(expanded);
  } catch {
    throw new ContentNormalizationError(
      'PATH_NOT_FOUND',
      `The input looks like a file path but no such file exists: ${rawPath}`,
      opts.explicit
        ? 'Check the path, or pass the content inline as base64, a data URL, or an http(s) URL.'
        : 'Check the path. If this string was meant as literal content, provide an explicit mime.'
    );
  }

  if (policy.localFileRoots.length > 0) {
    const roots = await Promise.all(
      policy.localFileRoots.map((r) => fs.realpath(expandTilde(r)).catch(() => null))
    );
    const inRoot = roots.some(
      (root) =>
        root !== null && (real === root || real.startsWith(root.endsWith(sep) ? root : root + sep))
    );
    if (!inRoot) {
      throw new ContentNormalizationError(
        'PATH_NOT_PERMITTED',
        `Path is outside the directories this server may read from: ${rawPath}`,
        'Pass the content inline as base64 or a data URL, or adjust --local-file-roots.'
      );
    }
  }

  const stats = await fs.stat(real);
  if (!stats.isFile()) {
    throw new ContentNormalizationError(
      'PATH_NOT_FOUND',
      `Path exists but is not a regular file: ${rawPath}`,
      'Point at a file, not a directory or special file.'
    );
  }
  if (stats.size > policy.maxBytes) {
    throw new ContentNormalizationError(
      'INPUT_TOO_LARGE',
      `File is ${stats.size} bytes; the limit is ${policy.maxBytes} bytes: ${rawPath}`,
      'Reduce the file size or raise --max-content-fetch-bytes.'
    );
  }

  const buffer = await fs.readFile(real);
  return finalize(buffer, 'path', { hints, sourceName: basename(expanded) });
}

// ============================================================================
// URL fetching
// ============================================================================

const MAX_REDIRECTS = 3;

function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Fetch with manual, re-guarded redirects; returns the final OK response. */
async function fetchGuarded(
  url: URL,
  policy: ContentInputPolicy
): Promise<{ response: Response; finalUrl: URL }> {
  let current = url;

  for (let redirects = 0; ; redirects++) {
    // Re-guard EVERY hop so a public URL cannot redirect us into a private
    // network or cloud metadata endpoint. (Known DNS TOCTOU between guard and
    // fetch — same accepted trade-off as the X-Trilium-Url guard.)
    try {
      await assertUrlIsSafe(current.href, policy.urlGuard);
    } catch (err) {
      if (err instanceof UrlGuardError) {
        throw new ContentNormalizationError(
          'URL_BLOCKED',
          `URL rejected (${err.reason}): ${current.href} — ${err.message}`,
          'Use a public URL, add the host to --content-url-allowlist, or (for private/homelab hosts) start the server with --allow-private-urls.'
        );
      }
      throw err;
    }

    let resp: Response;
    try {
      resp = await fetch(current.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(policy.fetchTimeoutMs),
      });
    } catch (err) {
      throw new ContentNormalizationError(
        'URL_FETCH_FAILED',
        `Could not fetch ${current.href}: ${err instanceof Error ? err.message : String(err)}`,
        'Check the URL is reachable from the server, or download the file and pass a local path or base64.'
      );
    }

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      await resp.body?.cancel().catch(() => {});
      if (!location) {
        throw new ContentNormalizationError(
          'URL_FETCH_FAILED',
          `Redirect from ${current.href} had no Location header.`,
          'Check the URL, or download the file and pass a local path or base64.'
        );
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new ContentNormalizationError(
          'URL_FETCH_FAILED',
          `Too many redirects fetching ${url.href}.`,
          'Use the final URL directly.'
        );
      }
      current = new URL(location, current);
      continue;
    }

    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      throw new ContentNormalizationError(
        'URL_FETCH_FAILED',
        `HTTP ${resp.status} fetching ${current.href}.`,
        'Check the URL, or download the file and pass a local path or base64.'
      );
    }

    return { response: resp, finalUrl: current };
  }
}

async function fetchFromUrl(
  url: URL,
  hints: ContentHints,
  policy: ContentInputPolicy
): Promise<ResolvedContent> {
  const { response, finalUrl } = await fetchGuarded(url, policy);

  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > policy.maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ContentNormalizationError(
      'INPUT_TOO_LARGE',
      `Remote content is ${declaredLength} bytes; the limit is ${policy.maxBytes} bytes: ${finalUrl.href}`,
      'Fetch a smaller resource or raise --max-content-fetch-bytes.'
    );
  }

  // Stream with a byte counter — Content-Length can lie or be absent.
  const chunks: Buffer[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > policy.maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ContentNormalizationError(
          'INPUT_TOO_LARGE',
          `Download exceeded the ${policy.maxBytes}-byte limit: ${finalUrl.href}`,
          'Fetch a smaller resource or raise --max-content-fetch-bytes.'
        );
      }
      chunks.push(Buffer.from(value));
    }
  }
  const buffer = Buffer.concat(chunks);

  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const pathBase = basename(url.pathname);
  return finalize(buffer, 'url', {
    hints,
    sourceName: pathBase && pathBase !== '/' ? pathBase : undefined,
    transportMime: contentType || undefined,
  });
}

// ============================================================================
// Inline content
// ============================================================================

async function resolveInline(
  raw: string,
  hints: ContentHints,
  pathCandidate: string | null
): Promise<ResolvedContent> {
  const pathOrBase64Error = (): ContentNormalizationError => {
    if (pathCandidate) {
      return new ContentNormalizationError(
        'PATH_NOT_FOUND',
        `The input looks like a file path but no such file exists: ${pathCandidate}`,
        'Check the path, or pass the content inline as base64, a data URL, or an http(s) URL.'
      );
    }
    return new ContentNormalizationError(
      'INVALID_BASE64',
      'Content for a binary MIME type must be valid base64 (or a file path, data URL, or http(s) URL).',
      'Re-encode the content as base64, or pass a file path or URL instead.'
    );
  };

  if (hints.mime) {
    if (isBinaryMimeType(hints.mime)) {
      const buffer = decodeBase64Strict(raw);
      if (buffer === null) throw pathOrBase64Error();
      return {
        buffer,
        mime: hints.mime,
        isBinary: true,
        origin: 'inline-base64',
      };
    }
    return {
      buffer: Buffer.from(raw, 'utf8'),
      mime: hints.mime,
      isBinary: false,
      origin: 'inline-text',
    };
  }

  // No mime given. Only treat the input as binary when a magic-byte sniff
  // POSITIVELY identifies it — short prose can be coincidentally valid base64,
  // and decoding it silently would store garbage.
  const decoded = decodeBase64Strict(raw);
  if (decoded && decoded.length > 0) {
    const sniffed = await fileTypeFromBuffer(decoded);
    if (sniffed) {
      return {
        buffer: decoded,
        mime: sniffed.mime,
        isBinary: isBinaryMimeType(sniffed.mime),
        origin: 'inline-base64',
      };
    }
  }

  const extMime = mimeFromExtension(hints.filename);
  if (extMime) {
    if (isBinaryMimeType(extMime)) {
      if (decoded === null) throw pathOrBase64Error();
      return { buffer: decoded, mime: extMime, isBinary: true, origin: 'inline-base64' };
    }
    return {
      buffer: Buffer.from(raw, 'utf8'),
      mime: extMime,
      isBinary: false,
      origin: 'inline-text',
    };
  }

  if (pathCandidate) throw pathOrBase64Error();
  throw new ContentNormalizationError(
    'UNDETECTABLE_MIME',
    'Could not determine the content type of the inline input.',
    'Provide a mime (e.g. "text/plain"), a filename with a known extension, or pass the content as a data URL, file path, or http(s) URL.'
  );
}

// ============================================================================
// MIME resolution
// ============================================================================

/**
 * Small internal extension→MIME map for types file-type cannot sniff
 * (text formats and SVG). Binary formats are covered by magic bytes.
 */
const EXTENSION_MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  cjs: 'application/javascript',
  ts: 'text/plain',
  xml: 'text/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  sql: 'application/x-sql',
  py: 'text/plain',
  sh: 'text/plain',
  ini: 'text/plain',
  toml: 'text/plain',
};

function mimeFromExtension(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return undefined;
  return EXTENSION_MIME[filename.slice(dot + 1).toLowerCase()];
}

function looksLikeSvg(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 512).toString('utf8').trimStart();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

/**
 * Resolve the final MIME for bytes fetched from a data URL, path, or URL.
 * Order: data-URL header (passed as resolvedMime) > explicit hint > magic-byte
 * sniff > SVG heuristic > HTTP Content-Type (below the sniff — servers
 * misconfigure) > extension map > UTF-8/octet-stream fallback.
 */
async function finalize(
  buffer: Buffer,
  origin: ContentOrigin,
  opts: {
    hints: ContentHints;
    resolvedMime?: string;
    transportMime?: string;
    sourceName?: string;
  }
): Promise<ResolvedContent> {
  let mime = opts.resolvedMime ?? opts.hints.mime;
  if (!mime) {
    const sniffed = await fileTypeFromBuffer(buffer);
    if (sniffed) mime = sniffed.mime;
  }
  if (!mime && looksLikeSvg(buffer)) mime = 'image/svg+xml';
  if (!mime && opts.transportMime) mime = opts.transportMime;
  if (!mime) mime = mimeFromExtension(opts.hints.filename ?? opts.sourceName);
  if (!mime) {
    // These bytes came from a real source the caller clearly intended to
    // upload — never fail, fall back to text or an opaque blob.
    mime = isUtf8(buffer) ? 'text/plain' : 'application/octet-stream';
  }

  return {
    buffer,
    mime,
    isBinary: isBinaryMimeType(mime),
    origin,
    sourceName: opts.sourceName,
  };
}
