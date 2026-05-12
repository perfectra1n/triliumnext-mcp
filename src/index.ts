#!/usr/bin/env node

import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { createLoggerForTransport } from './utils/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config === null) {
    // Help was shown, exit successfully
    process.exit(0);
  }

  const logger = createLoggerForTransport(config.transport);

  try {
    await createServer(config, logger);
  } catch (error) {
    logger.error('startup_failed', { err: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

main();
