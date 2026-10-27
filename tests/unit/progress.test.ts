import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../../src/server.js';
import { createLogger } from '../../src/utils/logger.js';
import type { TriliumClient } from '../../src/client/trilium.js';

const quietLogger = createLogger({ level: 'silent', stream: 'stderr' });

async function connect(trilium: TriliumClient) {
  const server = buildMcpServer(trilium, {
    logger: quietLogger,
    sessionId: 'test',
    progressIntervalMs: 10,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'progress-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describe('tool-call progress notifications', () => {
  it('sends heartbeats and search phase messages to a client that asked for progress', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const searchNotes = vi
      .fn()
      .mockResolvedValueOnce({ results: [] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          })
      );
    const { client, server } = await connect({ searchNotes } as unknown as TriliumClient);

    const messages: string[] = [];
    const call = client.callTool({ name: 'search_notes', arguments: { query: 'afi' } }, undefined, {
      onprogress: (p) => messages.push(String(p.message)),
    });

    await vi.waitFor(() => {
      expect(messages.some((m) => m.includes('note bodies'))).toBe(true);
      expect(messages.some((m) => m.includes('Still working on search_notes'))).toBe(true);
    });
    answer({ results: [] });
    const result = await call;
    expect(result.isError).toBeFalsy();

    await client.close();
    await server.close();
  });

  it('sends nothing when the client did not ask for progress', async () => {
    const searchNotes = vi.fn().mockResolvedValue({ results: [] });
    const { client, server } = await connect({ searchNotes } as unknown as TriliumClient);
    const notifications: unknown[] = [];
    client.fallbackNotificationHandler = async (n) => {
      notifications.push(n);
    };

    const result = await client.callTool({ name: 'search_notes', arguments: { query: 'afi' } });
    expect(result.isError).toBeFalsy();
    expect(notifications).toHaveLength(0);

    await client.close();
    await server.close();
  });
});
