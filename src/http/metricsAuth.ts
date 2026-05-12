import type { IncomingMessage } from 'node:http';
import { GatewayAuth } from './auth.js';

export type MetricsAuthMode = 'gateway' | 'bearer' | 'none';

/**
 * Authorization gate for the /metrics endpoint. Three modes:
 *  - `gateway`: reuse the existing gateway bearer (most common)
 *  - `bearer`: a separate set of bearer tokens for scrapers
 *  - `none`: open (use only when the endpoint is firewalled)
 */
export class MetricsAuth {
  private readonly mode: MetricsAuthMode;
  private readonly inner: GatewayAuth | null;

  constructor(mode: MetricsAuthMode, options: { gateway: GatewayAuth | null; bearerTokens: string[] }) {
    this.mode = mode;
    if (mode === 'gateway') {
      this.inner = options.gateway;
    } else if (mode === 'bearer') {
      // Reuse GatewayAuth's hashing + constant-time compare.
      this.inner = new GatewayAuth(options.bearerTokens);
    } else {
      this.inner = null;
    }
  }

  isAuthorized(req: IncomingMessage): boolean {
    if (this.mode === 'none') return true;
    // For both `gateway` and `bearer`, delegate to a GatewayAuth instance.
    // If `gateway` mode was selected but no gateway was configured, treat it
    // as misconfiguration (deny). loadConfig() catches this case at startup
    // and falls back to `none` with a warn, so reaching here means an
    // operator bypassed validation — better safe than open.
    if (!this.inner) return false;
    return this.inner.isAuthorized(req);
  }
}
