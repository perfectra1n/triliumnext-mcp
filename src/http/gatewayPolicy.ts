import type { IncomingMessage } from 'node:http';
import type { GatewayAuth } from './auth.js';
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
}
