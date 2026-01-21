#!/usr/bin/env node

import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config === null) {
    // Help was shown, exit successfully
    process.exit(0);
  }

  try {
    await createServer(config);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
