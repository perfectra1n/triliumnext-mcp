import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { extractBearerToken, type GatewayAuth } from './auth.js';
import type { JwtAuth } from './jwtAuth.js';

export type GatewayMode = 'none' | 'bearer' | 'jwt';

export interface AuthorizeResult {
  authorized: boolean;
  /**
   * Authenticated principal identifier (for audit logs / per-tenant metrics).
   * `null` in `none` / `bearer` modes — those treat the gateway token as a
   * capability, not an identity.
   */
  principal: string | null;
  /** Short, non-secret reason on failure. */
  reason?: string;
}

/**
 * Single front door for connect-time authorization. Wraps the underlying
 * mode-specific check so handlers can `await policy.authorize(req)` once
 * without branching on `gatewayAuth`. Also surfaces the authenticated
 * principal (only meaningful for JWT) for downstream audit/metrics.
 */
export class GatewayPolicy {
  constructor(
    private readonly mode: GatewayMode,
    private readonly bearer: GatewayAuth | null,
    private readonly jwt: JwtAuth | null
  ) {
    if (mode === 'bearer' && !bearer) throw new Error('mode=bearer requires a GatewayAuth');
    if (mode === 'jwt' && !jwt) throw new Error('mode=jwt requires a JwtAuth');
  }

  async authorize(req: IncomingMessage): Promise<AuthorizeResult> {
    if (this.mode === 'none') return { authorized: true, principal: null };
    if (this.mode === 'bearer' && this.bearer) {
      const ok = this.bearer.isAuthorized(req);
      return { authorized: ok, principal: null, reason: ok ? undefined : 'bad_token' };
    }
    if (this.mode === 'jwt' && this.jwt) {
      const result = await this.jwt.authorize(req);
      return {
        authorized: result.authorized,
        principal: result.principal,
        reason: result.reason,
      };
    }
    // Constructor invariants guarantee we never reach here in practice.
    return { authorized: false, principal: null, reason: 'misconfigured' };
  }

  get gatewayMode(): GatewayMode {
    return this.mode;
  }

  /**
   * Stable identity of an AUTHORIZED request, used to bind MCP sessions to
   * whoever created them:
   *  - jwt: the principal claim (survives token refresh)
   *  - bearer: a SHA-256 fingerprint of the gateway token (never the token)
   *  - none: a constant — there is no identity to bind to
   */
  identity(req: IncomingMessage, result: AuthorizeResult): string {
    if (this.mode === 'jwt') return `jwt:${result.principal ?? ''}`;
    if (this.mode === 'bearer') {
      const token = extractBearerToken(req.headers['authorization']) ?? '';
      return `bearer:${createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 32)}`;
    }
    return 'anonymous';
  }
}
