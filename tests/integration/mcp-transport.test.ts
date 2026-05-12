import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  startTriliumContainer,
  stopTriliumContainer,
  waitForTrilium,
  initializeTriliumDatabase,
  getTriliumHost,
} from './setup.js';
import {
  createStdioClient,
  createHttpClient,
  cleanup,
  getAvailablePort,
  EXPECTED_TOOL_COUNT,
} from './helpers/mcp-server.js';

describe('MCP Transport Integration Tests', () => {
  beforeAll(async () => {
    await startTriliumContainer();
    await waitForTrilium();
    await initializeTriliumDatabase();
  }, 120000);

  afterAll(async () => {
    await stopTriliumContainer();
  });

  describe('Stdio Transport', () => {
    let client: Client;
    let transport: StdioClientTransport;

    afterEach(async () => {
      if (client) await cleanup(client, transport);
    });

    it('should connect and list tools', async () => {
      const result = await createStdioClient(getTriliumHost());
      client = result.client;
      transport = result.transport;

      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(EXPECTED_TOOL_COUNT);
      expect(tools.tools.map((t) => t.name)).toContain('create_note');
      expect(tools.tools.map((t) => t.name)).toContain('get_note');
    });

    it('should call get_note for root', async () => {
      const result = await createStdioClient(getTriliumHost());
      client = result.client;
      transport = result.transport;

      const response = await client.callTool({ name: 'get_note', arguments: { noteId: 'root' } });
      const content = response.content as Array<{ type: string; text: string }>;
      const note = JSON.parse(content[0].text);

      expect(note.noteId).toBe('root');
      expect(note.title).toBe('root');
    });

    it('should create and delete a note', async () => {
      const result = await createStdioClient(getTriliumHost());
      client = result.client;
      transport = result.transport;

      // Create
      const createResponse = await client.callTool({
        name: 'create_note',
        arguments: {
          parentNoteId: 'root',
          title: 'Stdio Test Note',
          type: 'text',
          content: '<p>Test content</p>',
        },
      });
      const createContent = createResponse.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(createContent[0].text);
      expect(parsed.note).toBeDefined();
      expect(parsed.note.title).toBe('Stdio Test Note');
      const noteId = parsed.note.noteId;

      // Delete
      const deleteResponse = await client.callTool({
        name: 'delete_note',
        arguments: { noteId, action: 'delete' },
      });
      expect(deleteResponse.content).toBeDefined();
    });
  });

  describe('HTTP/SSE Transport', () => {
    let client: Client;
    let transport: SSEClientTransport;
    let serverProcess: ChildProcess;

    afterEach(async () => {
      if (client) await cleanup(client, transport, serverProcess);
    });

    it('should connect and list tools', async () => {
      const result = await createHttpClient(getTriliumHost());
      client = result.client;
      transport = result.transport;
      serverProcess = result.serverProcess;

      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(EXPECTED_TOOL_COUNT);
      expect(tools.tools.map((t) => t.name)).toContain('search_notes');
    });

    it('should call get_note for root', async () => {
      const result = await createHttpClient(getTriliumHost());
      client = result.client;
      transport = result.transport;
      serverProcess = result.serverProcess;

      const response = await client.callTool({ name: 'get_note', arguments: { noteId: 'root' } });
      const content = response.content as Array<{ type: string; text: string }>;
      const note = JSON.parse(content[0].text);

      expect(note.noteId).toBe('root');
    });

    it('should create and delete a note', async () => {
      const result = await createHttpClient(getTriliumHost());
      client = result.client;
      transport = result.transport;
      serverProcess = result.serverProcess;

      // Create
      const createResponse = await client.callTool({
        name: 'create_note',
        arguments: {
          parentNoteId: 'root',
          title: 'HTTP Test Note',
          type: 'text',
          content: '<p>HTTP test</p>',
        },
      });
      const createContent = createResponse.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(createContent[0].text);
      expect(parsed.note).toBeDefined();
      expect(parsed.note.title).toBe('HTTP Test Note');

      // Delete
      await client.callTool({
        name: 'delete_note',
        arguments: { noteId: parsed.note.noteId, action: 'delete' },
      });
    });

    it('should handle search_notes', async () => {
      const result = await createHttpClient(getTriliumHost());
      client = result.client;
      transport = result.transport;
      serverProcess = result.serverProcess;

      const response = await client.callTool({
        name: 'search_notes',
        arguments: { query: 'root' },
      });
      const content = response.content as Array<{ type: string; text: string }>;
      const searchResult = JSON.parse(content[0].text);

      expect(searchResult.results).toBeDefined();
    });
  });

  describe('Attachment Content Types', () => {
    let client: Client;
    let transport: StdioClientTransport;
    let testNoteId: string;

    afterEach(async () => {
      if (client) await cleanup(client, transport);
    });

    it('should return text content block for text attachments', async () => {
      const result = await createStdioClient(getTriliumHost());
      client = result.client;
      transport = result.transport;

      // Create a test note
      const noteResponse = await client.callTool({
        name: 'create_note',
        arguments: {
          parentNoteId: 'root',
          title: 'Text Attachment Test',
          type: 'text',
          content: '<p>Test</p>',
        },
      });
      const noteContent = noteResponse.content as Array<{ type: string; text: string }>;
      const noteParsed = JSON.parse(noteContent[0].text);
      expect(noteParsed.note).toBeDefined();
      testNoteId = noteParsed.note.noteId;

      // Create a text attachment
      const attachResponse = await client.callTool({
        name: 'create_attachment',
        arguments: {
          ownerId: testNoteId,
          role: 'file',
          mime: 'text/plain',
          title: 'test.txt',
          content: 'Hello World',
        },
      });
      const attachContent = attachResponse.content as Array<{ type: string; text: string }>;
      const attachment = JSON.parse(attachContent[0].text);

      // Get attachment content - should be text type
      const contentResponse = await client.callTool({
        name: 'get_attachment',
        arguments: { attachmentId: attachment.attachmentId, include_content: true },
      });

      const content = contentResponse.content as Array<{ type: string; text?: string }>;
      expect(content[0].type).toBe('text');
      expect(content[0].text).toBe('Hello World');

      // Cleanup
      await client.callTool({
        name: 'delete_note',
        arguments: { noteId: testNoteId, action: 'delete' },
      });
    });

    it('should return image content block for image attachments', async () => {
      const result = await createStdioClient(getTriliumHost());
      client = result.client;
      transport = result.transport;

      // Create a test note
      const noteResponse = await client.callTool({
        name: 'create_note',
        arguments: {
          parentNoteId: 'root',
          title: 'Image Attachment Test',
          type: 'text',
          content: '<p>Test</p>',
        },
      });
      const noteContent = noteResponse.content as Array<{ type: string; text: string }>;
      const noteParsed = JSON.parse(noteContent[0].text);
      expect(noteParsed.note).toBeDefined();
      testNoteId = noteParsed.note.noteId;

      // 1x1 PNG pixel in base64
      const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

      // Create an image attachment
      const attachResponse = await client.callTool({
        name: 'create_attachment',
        arguments: {
          ownerId: testNoteId,
          role: 'image',
          mime: 'image/png',
          title: 'test.png',
          content: pngBase64,
        },
      });
      const attachContent = attachResponse.content as Array<{ type: string; text: string }>;
      const attachment = JSON.parse(attachContent[0].text);

      // Get attachment content - should be image type
      const contentResponse = await client.callTool({
        name: 'get_attachment',
        arguments: { attachmentId: attachment.attachmentId, include_content: true },
      });

      const content = contentResponse.content as Array<{ type: string; data?: string; mimeType?: string }>;
      expect(content[0].type).toBe('image');
      expect(content[0].data).toBe(pngBase64);
      expect(content[0].mimeType).toBe('image/png');

      // Cleanup
      await client.callTool({
        name: 'delete_note',
        arguments: { noteId: testNoteId, action: 'delete' },
      });
    });

    it('should return image content block for JPEG attachments', async () => {
      const result = await createStdioClient(getTriliumHost());
      client = result.client;
      transport = result.transport;

      // Create a test note
      const noteResponse = await client.callTool({
        name: 'create_note',
        arguments: {
          parentNoteId: 'root',
          title: 'JPEG Attachment Test',
          type: 'text',
          content: '<p>Test</p>',
        },
      });
      const noteContent = noteResponse.content as Array<{ type: string; text: string }>;
      const noteParsed = JSON.parse(noteContent[0].text);
      expect(noteParsed.note).toBeDefined();
      testNoteId = noteParsed.note.noteId;

      // Minimal valid JPEG in base64 (1x1 red pixel)
      const jpegBase64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof';

      // Create a JPEG attachment
      const attachResponse = await client.callTool({
        name: 'create_attachment',
        arguments: {
          ownerId: testNoteId,
          role: 'image',
          mime: 'image/jpeg',
          title: 'test.jpg',
          content: jpegBase64,
        },
      });
      const attachContent = attachResponse.content as Array<{ type: string; text: string }>;
      const attachment = JSON.parse(attachContent[0].text);

      // Get attachment content - should be image type
      const contentResponse = await client.callTool({
        name: 'get_attachment',
        arguments: { attachmentId: attachment.attachmentId, include_content: true },
      });

      const content = contentResponse.content as Array<{ type: string; data?: string; mimeType?: string }>;
      expect(content[0].type).toBe('image');
      expect(content[0].mimeType).toBe('image/jpeg');

      // Cleanup
      await client.callTool({
        name: 'delete_note',
        arguments: { noteId: testNoteId, action: 'delete' },
      });
    });
  });

  describe('Request body size limits', () => {
    let client: Client;
    let transport: SSEClientTransport;
    let serverProcess: ChildProcess;

    afterEach(async () => {
      if (client) await cleanup(client, transport, serverProcess);
    });

    /**
     * Opens an SSE connection via raw fetch and returns the sessionId published
     * in the `endpoint` event. Lets us POST oversized bodies directly without
     * the MCP client SDK refusing or rewriting them.
     */
    async function openSseSessionRaw(serverPort: number): Promise<{
      sessionId: string;
      close: () => void;
    }> {
      const controller = new AbortController();
      const response = await fetch(`http://localhost:${serverPort}/sse`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.body) throw new Error('SSE response had no body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const deadline = Date.now() + 10_000;

      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE closed before endpoint event');
        buffer += decoder.decode(value, { stream: true });
        const match = buffer.match(/event:\s*endpoint\s*\ndata:\s*(.+?)\r?\n\r?\n/);
        if (match) {
          const endpointPath = match[1].trim();
          const url = new URL(endpointPath, `http://localhost:${serverPort}`);
          const sessionId = url.searchParams.get('sessionId');
          if (!sessionId) throw new Error('endpoint event missing sessionId');
          return { sessionId, close: () => controller.abort() };
        }
      }
      throw new Error('Timed out waiting for endpoint event');
    }

    it('should reject POST bodies that exceed the configured cap with 413', async () => {
      const port = await getAvailablePort();
      const result = await createHttpClient(getTriliumHost(), port, {
        TRILIUM_MAX_POST_BYTES: '4096', // 4 KiB
      });
      client = result.client;
      transport = result.transport;
      serverProcess = result.serverProcess;

      const session = await openSseSessionRaw(port);
      try {
        // Build a JSON-RPC payload well above the 4 KiB cap.
        const fatArg = 'A'.repeat(20_000);
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_note', arguments: { noteId: 'root', _pad: fatArg } },
        });

        const resp = await fetch(
          `http://localhost:${port}/message?sessionId=${encodeURIComponent(session.sessionId)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          }
        );

        expect(resp.status).toBe(413);
        const json = (await resp.json()) as { error: string };
        expect(json.error).toBe('payload_too_large');
      } finally {
        session.close();
      }
    });

    it('should accept a >4MB random-binary attachment and store it byte-correctly', async () => {
      // Default cap is 500 MB; we just need to exceed the SDK's hardcoded 4 MB
      // internal getRawBody cap so the body must flow through readJsonBody +
      // parsedBody. Random bytes (vs a degenerate 'A'.repeat) ensure every
      // base64 character class is exercised in JSON.parse and base64 decode.
      const result = await createHttpClient(getTriliumHost());
      client = result.client;
      transport = result.transport;
      serverProcess = result.serverProcess;

      const FIVE_MIB = 5 * 1024 * 1024;
      const binary = randomBytes(FIVE_MIB);
      const sentBase64 = binary.toString('base64'); // ~6.67 MiB base64

      const noteResponse = await client.callTool({
        name: 'create_note',
        arguments: {
          parentNoteId: 'root',
          title: 'Big-binary-attachment owner',
          type: 'text',
          content: '<p>owner</p>',
        },
      });
      const ownerId = JSON.parse(
        (noteResponse.content as Array<{ type: string; text: string }>)[0].text
      ).note.noteId as string;

      try {
        // Upload exercises handleSsePost → readJsonBody → JSON.parse →
        // base64 decode → Trilium PUT. If readJsonBody truncated, JSON.parse
        // would throw. If JSON.parse / base64 decode corrupted bytes, the
        // server-side Buffer would have wrong length.
        const attachResponse = await client.callTool({
          name: 'create_attachment',
          arguments: {
            ownerId,
            role: 'file',
            mime: 'application/octet-stream',
            title: 'big-binary.bin',
            content: sentBase64,
          },
        });
        const attachment = JSON.parse(
          (attachResponse.content as Array<{ type: string; text: string }>)[0].text
        );
        expect(attachment.attachmentId).toBeTruthy();

        // Byte-fidelity check: contentLength reported by Trilium must equal
        // the original raw byte count. Anything wrong with how we read the
        // request body or decoded the base64 server-side would surface here
        // (truncation, character mangling, padding loss, off-by-one, etc.).
        const metaResponse = await client.callTool({
          name: 'get_attachment',
          arguments: { attachmentId: attachment.attachmentId, include_content: false },
        });
        const meta = JSON.parse(
          (metaResponse.content as Array<{ type: string; text: string }>)[0].text
        );
        expect(meta.contentLength).toBe(FIVE_MIB);
      } finally {
        await client
          .callTool({ name: 'delete_note', arguments: { noteId: ownerId, action: 'delete' } })
          .catch(() => {});
      }
    });
  });

  describe('Transport Parity', () => {
    it('should return identical tool lists from both transports', async () => {
      const stdio = await createStdioClient(getTriliumHost());
      const http = await createHttpClient(getTriliumHost());

      try {
        const stdioTools = await stdio.client.listTools();
        const httpTools = await http.client.listTools();

        const stdioNames = stdioTools.tools.map((t) => t.name).sort();
        const httpNames = httpTools.tools.map((t) => t.name).sort();

        expect(stdioNames).toEqual(httpNames);
        expect(stdioNames).toHaveLength(EXPECTED_TOOL_COUNT);
      } finally {
        await cleanup(stdio.client, stdio.transport);
        await cleanup(http.client, http.transport, http.serverProcess);
      }
    });
  });
});
