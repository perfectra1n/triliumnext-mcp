import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Holds the SHA-256 digests of all accepted gateway bearer tokens so the
 * plaintext tokens never sit around in memory after startup.
 */
export class GatewayAuth {
  private readonly acceptedHashes: Buffer[];

  constructor(tokens: string[]) {
    this.acceptedHashes = tokens.map((t) => createHash('sha256').update(t, 'utf8').digest());
  }

  /**
   * Returns true if the incoming request carries a valid bearer token.
   * Comparison is constant-time against every configured hash; we always
   * do the full loop to avoid leaking the number of configured tokens via timing.
   */
  isAuthorized(req: IncomingMessage): boolean {
    if (this.acceptedHashes.length === 0) return false;

    const token = extractBearerToken(req.headers['authorization']);
    if (!token) {
      // Still do a dummy compare to keep timing flat between "missing header"
      // and "wrong token".
      dummyCompare(this.acceptedHashes[0]);
      return false;
    }

    const candidate = createHash('sha256').update(token, 'utf8').digest();

    let matched = false;
    for (const hash of this.acceptedHashes) {
      if (timingSafeEqual(candidate, hash)) {
        matched = true;
      }
    }
    return matched;
  }
}

/**
 * Extracts the raw token from an `Authorization: Bearer <tok>` header.
 * Returns null for any malformed input.
 */
export function extractBearerToken(header: string | string[] | undefined): string | null {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match ? match[1] : null;
}

function dummyCompare(reference: Buffer): void {
  const zero = Buffer.alloc(reference.length);
  try {
    timingSafeEqual(zero, reference);
  } catch {
    // Length mismatch — ignore, this is defensive.
  }
}
