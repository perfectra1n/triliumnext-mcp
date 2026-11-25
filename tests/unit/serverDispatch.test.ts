import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { TriliumClient } from '../../src/client/trilium.js';
import { buildMcpServer } from '../../src/server.js';
import { SERVER_VERSION } from '../../src/version.js';
import { SERVER_INSTRUCTIONS } from '../../src/server-instructions.js';
import { createMetrics } from '../../src/http/metrics.js';
import { createLogger } from '../../src/utils/logger.js';

async function connect() {
  const metrics = createMetrics('test');
  const server = buildMcpServer({} as TriliumClient, {
    logger: createLogger({ level: 'silent' }),
    sessionId: 't',
    metrics,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, metrics };
}

describe('buildMcpServer dispatch', () => {
  it('reports the package.json version', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(SERVER_VERSION).toBe(pkg.version);
    const { client } = await connect();
    expect(client.getServerVersion()?.version).toBe(pkg.version);
  });

  it('answers an unknown tool with isError and the valid tool names', async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: 'no_such_tool', arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Unknown tool: no_such_tool');
    expect(text).toContain('search_notes');
    expect(text).toContain('organize_note');
  });

  it("labels unknown tools as 'unknown' in metrics", async () => {
    const { client, metrics } = await connect();
    await client.callTool({ name: 'attacker_controlled_name_1', arguments: {} });
    await client.callTool({ name: 'attacker_controlled_name_2', arguments: {} });
    const body = metrics.registry.render();
    expect(body).not.toContain('attacker_controlled_name');
    expect(body).toMatch(/tool="unknown"/);
  });
});

describe('server instructions', () => {
  it('stays concise and carries the cross-tool facts', () => {
    expect(SERVER_INSTRUCTIONS.split(/\s+/).length).toBeLessThan(450);
    expect(SERVER_INSTRUCTIONS).toContain('format="html"');
    expect(SERVER_INSTRUCTIONS).toContain('url');
    expect(SERVER_INSTRUCTIONS).toContain('cannot read its contents');
    expect(SERVER_INSTRUCTIONS).not.toContain('ALWAYS');
  });
});
