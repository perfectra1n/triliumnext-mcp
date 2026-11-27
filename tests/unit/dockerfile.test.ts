import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * Static checks that keep the Dockerfile's HEALTHCHECK consistent with the
 * address the server binds to inside the container.
 *
 * Regression for #150: the image set TRILIUM_HTTP_HOST=0.0.0.0 (IPv4 only)
 * while the healthcheck probed http://localhost:3000. In the alpine image
 * /etc/hosts maps localhost to ::1 as well, busybox wget connects to ::1
 * first, and the probe failed with "connection refused" although the server
 * was up. The end-to-end version of this check (build the image, wait for
 * Docker to report "healthy") runs in CI via scripts/docker-healthcheck-smoke.sh.
 */

const dockerfile = readFileSync(
  fileURLToPath(new URL('../../Dockerfile', import.meta.url)),
  'utf8'
);

/** Instructions of the final build stage, with backslash continuations joined. */
function finalStageInstructions(source: string): string[] {
  const joined = source.replace(/\\\r?\n/g, ' ');
  const lines = joined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  const lastFrom = lines.map((l) => /^FROM\s/i.test(l)).lastIndexOf(true);
  return lines.slice(lastFrom);
}

const instructions = finalStageInstructions(dockerfile);

function envValue(name: string): string | undefined {
  let value: string | undefined;
  for (const line of instructions) {
    const m = new RegExp(`^ENV\\s+${name}[=\\s]\\s*"?([^"\\s]+)"?`, 'i').exec(line);
    if (m) value = m[1];
  }
  return value;
}

function healthcheckUrl(): URL {
  const line = instructions.find((l) => /^HEALTHCHECK\s/i.test(l));
  expect(line, 'final stage must declare a HEALTHCHECK').toBeDefined();
  const m = /https?:\/\/\S+/.exec(line!);
  expect(m, 'HEALTHCHECK must probe an http(s) URL').not.toBeNull();
  return new URL(m![0]);
}

/** URL hostname without the brackets URL keeps around IPv6 literals. */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

describe('Dockerfile HEALTHCHECK', () => {
  const bindHost = envValue('TRILIUM_HTTP_HOST');
  const url = healthcheckUrl();
  const probeHost = bareHost(url);

  it('sets an explicit TRILIUM_HTTP_HOST bind address', () => {
    expect(bindHost).toBeDefined();
    expect(isIP(bindHost!)).not.toBe(0);
  });

  it('probes an IP literal, not a hostname whose address family is ambiguous', () => {
    // "localhost" resolves to both 127.0.0.1 and ::1; which one wget uses
    // depends on the image, so it can miss a single-stack listener.
    expect(isIP(probeHost), `healthcheck host "${probeHost}" must be an IP literal`).not.toBe(0);
  });

  it('probes an address the server is listening on', () => {
    const family = isIP(bindHost!);
    if (bindHost === '0.0.0.0') {
      // IPv4 wildcard: only IPv4 addresses are reachable.
      expect(isIP(probeHost)).toBe(4);
      expect(probeHost.startsWith('127.')).toBe(true);
    } else if (bindHost === '::') {
      // IPv6 wildcard is dual-stack on Linux, so either loopback works.
      expect(['127.0.0.1', '::1']).toContain(probeHost);
    } else {
      // Specific address: the probe must hit exactly that address.
      expect(isIP(probeHost)).toBe(family);
      expect(probeHost).toBe(bindHost);
    }
  });

  it('probes the exposed port and the unauthenticated /health endpoint', () => {
    const expose = instructions.find((l) => /^EXPOSE\s/i.test(l));
    expect(expose).toBeDefined();
    const exposedPort = /^EXPOSE\s+(\d+)/i.exec(expose!)![1];
    expect(url.port).toBe(exposedPort);
    expect(url.pathname).toBe('/health');
  });
});
