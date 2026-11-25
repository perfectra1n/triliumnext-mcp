import { createRequire } from 'node:module';

/**
 * Server version, read from package.json at runtime so it never drifts from the
 * published package. Resolved relative to this module: `src/version.ts` and
 * `dist/version.js` both sit one level below the package root.
 */
function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_VERSION = readVersion();
