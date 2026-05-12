import type { IncomingMessage } from 'node:http';
import {
  jwtVerify,
  createRemoteJWKSet,
  type JWTVerifyOptions,
  type JWTVerifyGetKey,
} from 'jose';
import { extractBearerToken } from './auth.js';

export interface JwtAuthOptions {
  /** HS256 shared secrets (any one valid → accept). Empty → JWKS-only. */
  secrets?: string[];
  /** Public-key URL for asymmetric (RS256/ES256/EdDSA) verification. */
  jwksUrl?: string;
  /** Required `iss` claim. Omit to skip issuer validation. */
  issuer?: string;
  /** Required `aud` claim (string or array). Omit to skip audience validation. */
  audience?: string | string[];
  /** Which claim names the principal (for audit / per-tenant labels). Default: `sub`. */
  principalClaim?: string;
  /** Allowed signing algorithms. Defaults to a sane set; never includes `none`. */
  algorithms?: string[];
}

export interface JwtAuthResult {
  authorized: boolean;
  principal: string | null;
  /** When unauthorized, a short non-secret reason useful for logs. */
  reason?: 'no_token' | 'verify_failed' | 'no_principal';
}

const DEFAULT_ALGS = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'EdDSA'];

/**
 * JWT-based gateway auth. Supports HS256 shared secrets and asymmetric
 * verification via a JWKS URL (the standard OIDC pattern). Validates `exp`
 * and `nbf` automatically; `iss` and `aud` are validated when configured.
 *
 * The "principal" returned from authorization is whatever claim the operator
 * names (default `sub`). It threads into audit logs and, opt-in, into
 * per-tenant metrics labels.
 */
export class JwtAuth {
  private readonly principalClaim: string;
  private readonly issuer?: string;
  private readonly audience?: string | string[];
  private readonly algorithms: string[];
  private readonly hsKeys: Uint8Array[];
  private readonly jwks: JWTVerifyGetKey | null;

  constructor(opts: JwtAuthOptions) {
    this.principalClaim = opts.principalClaim ?? 'sub';
    this.issuer = opts.issuer;
    this.audience = opts.audience;
    this.algorithms = opts.algorithms ?? DEFAULT_ALGS;
    const enc = new TextEncoder();
    this.hsKeys = (opts.secrets ?? []).map((s) => enc.encode(s));
    this.jwks = opts.jwksUrl ? createRemoteJWKSet(new URL(opts.jwksUrl)) : null;
    if (this.hsKeys.length === 0 && !this.jwks) {
      throw new Error('JwtAuth requires at least one shared secret or a JWKS URL');
    }
  }

  async authorize(req: IncomingMessage): Promise<JwtAuthResult> {
    const token = extractBearerToken(req.headers['authorization']);
    if (!token) return { authorized: false, principal: null, reason: 'no_token' };

    const verifyOpts: JWTVerifyOptions = { algorithms: this.algorithms };
    if (this.issuer !== undefined) verifyOpts.issuer = this.issuer;
    if (this.audience !== undefined) verifyOpts.audience = this.audience;

    // Try each HS key, then JWKS. Order matters only for clarity; any one
    // successful verification authorizes the request.
    for (const key of this.hsKeys) {
      try {
        const { payload } = await jwtVerify(token, key, verifyOpts);
        return this.fromPayload(payload);
      } catch {
        // Try the next key / fall through to JWKS.
      }
    }
    if (this.jwks) {
      try {
        const { payload } = await jwtVerify(token, this.jwks, verifyOpts);
        return this.fromPayload(payload);
      } catch {
        // fall through
      }
    }
    return { authorized: false, principal: null, reason: 'verify_failed' };
  }

  private fromPayload(payload: Record<string, unknown>): JwtAuthResult {
    const claim = payload[this.principalClaim];
    if (typeof claim !== 'string' || claim.length === 0) {
      return { authorized: false, principal: null, reason: 'no_principal' };
    }
    return { authorized: true, principal: claim };
  }
}
