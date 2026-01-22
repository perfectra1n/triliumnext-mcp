import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { TriliumClient } from '../../src/client/trilium.js';

let triliumContainer: StartedTestContainer | null = null;
let triliumUrl: string;

const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 2000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start Trilium container using testcontainers
 */
export async function startTriliumContainer(): Promise<string> {
  // If TRILIUM_URL is set, use external instance (for local development)
  if (process.env.TRILIUM_URL) {
    triliumUrl = process.env.TRILIUM_URL;
    console.log(`Using external Trilium at: ${triliumUrl}`);
    return triliumUrl;
  }

  console.log('Starting Trilium container via testcontainers...');

  triliumContainer = await new GenericContainer('triliumnext/notes:latest')
    .withExposedPorts(8080)
    .withEnvironment({ TRILIUM_GENERAL_NOAUTHENTICATION: 'true' })
    .withWaitStrategy(Wait.forHttp('/api/app-info', 8080).forStatusCode(200))
    .withStartupTimeout(120000)
    .start();

  const host = triliumContainer.getHost();
  const port = triliumContainer.getMappedPort(8080);
  triliumUrl = `http://${host}:${port}/etapi`;

  console.log(`Trilium container started at: ${triliumUrl}`);
  return triliumUrl;
}

/**
 * Stop Trilium container
 */
export async function stopTriliumContainer(): Promise<void> {
  if (triliumContainer) {
    console.log('Stopping Trilium container...');
    await triliumContainer.stop();
    triliumContainer = null;
  }
}

/**
 * Get the Trilium base URL (without /etapi)
 */
export function getTriliumHost(): string {
  return triliumUrl.replace('/etapi', '');
}

/**
 * Wait for Trilium to be ready by polling the health check endpoint
 */
export async function waitForTrilium(): Promise<void> {
  const healthUrl = `${getTriliumHost()}/api/health-check`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        console.log(`Trilium is ready after ${attempt} attempt(s)`);
        return;
      }
    } catch {
      // Connection refused or other error - Trilium not ready yet
    }

    if (attempt < MAX_RETRIES) {
      console.log(`Waiting for Trilium... (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  throw new Error(`Trilium did not become ready after ${MAX_RETRIES} attempts`);
}

/**
 * Initialize a new Trilium database document
 * This is required for a fresh Trilium instance before any ETAPI calls work
 */
export async function initializeTriliumDatabase(): Promise<void> {
  const setupUrl = `${getTriliumHost()}/api/setup/new-document`;

  try {
    const response = await fetch(setupUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (response.ok) {
      console.log('Trilium database initialized');
      // Give Trilium a moment to fully initialize after setup
      await sleep(1000);
      return;
    }

    // If status is 409 or similar, database may already be initialized
    const text = await response.text();
    console.log(`Database setup response (${response.status}): ${text}`);
  } catch (error) {
    console.log('Database setup request error:', error);
  }
}

/**
 * Create a TriliumClient configured for integration testing
 * Uses TRILIUM_GENERAL_NOAUTHENTICATION=true so no token is required
 */
export function createTestClient(): TriliumClient {
  // With TRILIUM_GENERAL_NOAUTHENTICATION=true, no token is needed
  // But the client still expects a token parameter
  return new TriliumClient(triliumUrl, '');
}

/**
 * Full setup for integration tests
 */
export async function setupIntegrationTests(): Promise<TriliumClient> {
  await startTriliumContainer();
  await waitForTrilium();
  await initializeTriliumDatabase();
  return createTestClient();
}
