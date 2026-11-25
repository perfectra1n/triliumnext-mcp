import { promises as fs } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import {
  assertUrlIsSafe,
  createGuardedFetch,
  findUrlGuardError,
  UrlGuardError,
  type GuardedFetch,
} from '../http/urlGuard.js';
import type { Logger } from '../utils/logger.js';

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
  'Pass any of: an http(s) URL, a data URL (data:image/png;base64,...), or inline base64 ' +
  '(binary types) / raw text (text types) — the source is auto-detected. A file path ' +
  '("/abs/path", "~/path", or file://...) refers to the MCP SERVER\'s filesystem and only ' +
  'works when the server permits local file reads.';

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
  | 'UNDETECTABLE_MIME'
  | 'TITLE_REQUIRED';

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
  /**
   * Optional operator log sink. Receives the internal detail (e.g. resolved
   * IP) for blocked URLs, which is deliberately kept out of client-facing
   * error messages.
   */
  logger?: Pick<Logger, 'warn'>;
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
    // Cheap pre-check before decoding: decoded size is <= the payload length.
    assertEncodedWithinLimit(raw, policy.maxBytes, 'data URL');
    const parsed = parseDataUrl(raw);
    if (parsed) {
      assertWithinLimit(parsed.buffer.length, policy.maxBytes, 'data URL');
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
  //
  //    The read policy is checked BEFORE touching the filesystem, so a
  //    disallowed path never reveals whether it exists.
  let pathCandidate: PathCandidate | null = null;
  if (raw.length <= 1024 && /^(~\/|\/)[^\n\0]*$/.test(raw)) {
    const expanded = expandTilde(raw);
    if (pathPolicyPermits(expanded, policy)) {
      const stats = await fs.stat(expanded).catch(() => null);
      if (stats?.isFile()) {
        return await readFromPath(raw, hints, policy, { explicit: false });
      }
      pathCandidate = { raw, permitted: true };
    } else {
      pathCandidate = { raw, permitted: false };
    }
  }

  // 5. Inline content (today's behavior, mime-driven).
  return await resolveInline(raw, hints, pathCandidate, policy.maxBytes);
}

interface PathCandidate {
  raw: string;
  /** False when the read policy refused the path before any filesystem access. */
  permitted: boolean;
}

function assertWithinLimit(bytes: number, maxBytes: number, what: string): void {
  if (bytes > maxBytes) {
    throw new ContentNormalizationError(
      'INPUT_TOO_LARGE',
      `Decoded ${what} is ${bytes} bytes; the limit is ${maxBytes} bytes.`,
      'Send smaller content or raise --max-content-fetch-bytes.'
    );
  }
}

/** Reject before decoding when even the most compact encoding would exceed the cap. */
function assertEncodedWithinLimit(encoded: string, maxBytes: number, what: string): void {
  // base64 decodes to ~3/4 of its length; percent-encoded text to <= its length.
  const lowerBound = Math.floor((encoded.length * 3) / 4) - 4;
  if (lowerBound > maxBytes) {
    throw new ContentNormalizationError(
      'INPUT_TOO_LARGE',
      `Encoded ${what} is too large; the decoded limit is ${maxBytes} bytes.`,
      'Send smaller content or raise --max-content-fetch-bytes.'
    );
  }
}

// ============================================================================
// Path reading
// ============================================================================

function expandTilde(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** Pseudo-filesystems that must never be read, even inside an allowed root. */
const FORBIDDEN_PREFIXES = ['/proc', '/sys', '/dev'];

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function isForbiddenPath(path: string): boolean {
  return FORBIDDEN_PREFIXES.some((p) => isUnder(path, p));
}

/**
 * Policy gate evaluated WITHOUT touching the filesystem: local reads enabled,
 * absolute path, and (when roots are configured) lexically inside a root.
 * Symlink escapes are caught later by re-checking the realpath.
 */
function pathPolicyPermits(expanded: string, policy: ContentInputPolicy): boolean {
  if (!policy.allowLocalFileRead) return false;
  if (!isAbsolute(expanded)) return false;
  const normalized = resolve(expanded);
  if (isForbiddenPath(normalized)) return false;
  if (policy.localFileRoots.length === 0) return true;
  return policy.localFileRoots.some((r) => isUnder(normalized, resolve(expandTilde(r))));
}

const LOCAL_FILE_GENERIC_MESSAGE = 'Local file not permitted or not found';
const LOCAL_FILE_SUGGESTION =
  "File paths refer to the MCP server's filesystem and only work when the server permits " +
  'local reads (--allow-local-file-read, --local-file-roots). Otherwise pass the content ' +
  'inline as base64, a data URL, or an http(s) URL.';

function localFileError(
  code: 'PATH_NOT_FOUND' | 'PATH_NOT_PERMITTED',
  rawPath: string
): ContentNormalizationError {
  // One message for "missing", "outside roots", "disabled" and "special file"
  // so the response never confirms whether a path exists.
  return new ContentNormalizationError(
    code,
    `${LOCAL_FILE_GENERIC_MESSAGE}: ${rawPath}`,
    LOCAL_FILE_SUGGESTION
  );
}

async function readFromPath(
  rawPath: string,
  hints: ContentHints,
  policy: ContentInputPolicy,
  _opts: { explicit: boolean }
): Promise<ResolvedContent> {
  const expanded = expandTilde(rawPath);

  // Policy BEFORE any filesystem access.
  if (!pathPolicyPermits(expanded, policy)) {
    throw localFileError('PATH_NOT_PERMITTED', rawPath);
  }

  // Resolve symlinks, then re-check roots + forbidden prefixes on the real
  // path so a link inside an allowed root cannot point outside the sandbox.
  let real: string;
  try {
    real = await fs.realpath(expanded);
  } catch {
    throw localFileError('PATH_NOT_FOUND', rawPath);
  }
  if (isForbiddenPath(real)) {
    throw localFileError('PATH_NOT_PERMITTED', rawPath);
  }
  if (policy.localFileRoots.length > 0) {
    const roots = await Promise.all(
      policy.localFileRoots.map((r) => fs.realpath(expandTilde(r)).catch(() => null))
    );
    if (!roots.some((root) => root !== null && isUnder(real, root))) {
      throw localFileError('PATH_NOT_PERMITTED', rawPath);
    }
  }

  // Open once and work on the descriptor so the checked file is the read file.
  // Read at most maxBytes+1: stat sizes lie for pseudo-files (size 0).
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(real, 'r');
  } catch {
    throw localFileError('PATH_NOT_FOUND', rawPath);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw localFileError('PATH_NOT_FOUND', rawPath);
    }
    if (stats.size > policy.maxBytes) {
      throw tooLargeFile(stats.size, policy.maxBytes, rawPath);
    }
    const cap = policy.maxBytes + 1;
    const buf = Buffer.allocUnsafe(Math.min(cap, Math.max(stats.size + 1, 64 * 1024)));
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const want = Math.min(buf.length, cap - total);
      if (want <= 0) break;
      const { bytesRead } = await handle.read(buf, 0, want, null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
      total += bytesRead;
    }
    if (total > policy.maxBytes) {
      throw tooLargeFile(total, policy.maxBytes, rawPath);
    }
    return finalize(Buffer.concat(chunks, total), 'path', {
      hints,
      sourceName: basename(expanded),
    });
  } finally {
    await handle.close().catch(() => {});
  }
}

function tooLargeFile(size: number, maxBytes: number, rawPath: string): ContentNormalizationError {
  return new ContentNormalizationError(
    'INPUT_TOO_LARGE',
    `File exceeds the ${maxBytes}-byte limit (read at least ${size} bytes): ${rawPath}`,
    'Reduce the file size or raise --max-content-fetch-bytes.'
  );
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

/** Guarded fetchers keyed by URL-guard policy (each owns a pooled undici Agent). */
const guardedFetchers = new Map<string, GuardedFetch>();

function guardedFetchFor(policy: ContentInputPolicy): GuardedFetch {
  const key = JSON.stringify([policy.urlGuard.allowPrivate, policy.urlGuard.allowlist]);
  let f = guardedFetchers.get(key);
  if (!f) {
    f = createGuardedFetch(policy.urlGuard);
    guardedFetchers.set(key, f);
  }
  return f;
}

function urlBlocked(err: UrlGuardError, url: URL, policy: ContentInputPolicy): never {
  // The resolved IP (err.detail) goes to the operator log only.
  policy.logger?.warn('content_url_blocked', {
    reason: err.reason,
    host: url.hostname,
    detail: err.detail,
  });
  throw new ContentNormalizationError(
    'URL_BLOCKED',
    `URL rejected (${err.reason}): ${url.href}`,
    'Use a public URL, add the host to --content-url-allowlist, or (for private/homelab hosts) start the server with --allow-private-urls.'
  );
}

/** Fetch with manual, re-guarded redirects; returns the final OK response. */
async function fetchGuarded(
  url: URL,
  policy: ContentInputPolicy
): Promise<{ response: Response; finalUrl: URL }> {
  let current = url;
  const guardedFetch = guardedFetchFor(policy);

  for (let redirects = 0; ; redirects++) {
    // Re-guard EVERY hop so a public URL cannot redirect us into a private
    // network or cloud metadata endpoint. The pre-flight check gives a clean
    // error; the guarded dispatcher re-validates the address actually
    // connected to, which closes the DNS-rebinding TOCTOU window.
    try {
      await assertUrlIsSafe(current.href, policy.urlGuard);
    } catch (err) {
      if (err instanceof UrlGuardError) urlBlocked(err, current, policy);
      throw err;
    }

    let resp: Response;
    try {
      resp = await guardedFetch(current.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(policy.fetchTimeoutMs),
      });
    } catch (err) {
      const guardErr = findUrlGuardError(err);
      if (guardErr) urlBlocked(guardErr, current, policy);
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
  pathCandidate: PathCandidate | null,
  maxBytes: number
): Promise<ResolvedContent> {
  const pathOrBase64Error = (): ContentNormalizationError => {
    if (pathCandidate) {
      return localFileError(
        pathCandidate.permitted ? 'PATH_NOT_FOUND' : 'PATH_NOT_PERMITTED',
        pathCandidate.raw
      );
    }
    return new ContentNormalizationError(
      'INVALID_BASE64',
      'Content for a binary MIME type must be valid base64 (or a file path, data URL, or http(s) URL).',
      'Re-encode the content as base64, or pass a file path or URL instead.'
    );
  };

  // Bound decoded inline base64 by the same cap as file reads / downloads.
  // `strict` (binary mime declared) also rejects oversize input before decoding.
  const decodeBounded = (strict: boolean): Buffer | null => {
    if (strict) assertEncodedWithinLimit(raw, maxBytes, 'inline base64');
    const buf = decodeBase64Strict(raw);
    if (buf) assertWithinLimit(buf.length, maxBytes, 'inline base64');
    return buf;
  };

  if (hints.mime) {
    if (isBinaryMimeType(hints.mime)) {
      const buffer = decodeBounded(true);
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
  const decoded = decodeBounded(false);
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
