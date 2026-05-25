import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
  createStreamableHttpClient,
  cleanup,
  getAvailablePort,
  EXPECTED_TOOL_COUNT,
} from './helpers/mcp-server.js';

/**
 * Pull the text out of the first content block and JSON-parse it. Used for
 * tool responses that return a single JSON metadata block (create_note,
 * search_notes, get_attributes, etc.). On parse failure, re-throw with the
 * raw text so the test report shows the actual response (tool errors come
 * back as markdown rather than JSON).
 */
function parseJsonResponse<T = unknown>(response: { content: unknown }): T {
  const content = response.content as Array<{ type: string; text: string }>;
  const raw = content[0]?.text ?? '';
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `Expected JSON in tool response but got: ${raw.slice(0, 500)}${raw.length > 500 ? '…' : ''}`,
      { cause: err }
    );
  }
}

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

    it('should call get_note for root (metadata path)', async () => {
      const result = await createStdioClient(getTriliumHost());
      client = result.client;
      transport = result.transport;

      // include_content=false guarantees a single JSON metadata block,
      // independent of whether root has any body content.
      const response = await client.callTool({
        name: 'get_note',
        arguments: { noteId: 'root', include_content: false },
      });
      const content = response.content as Array<{ type: string; text: string }>;
      const note = JSON.parse(content[0].text);

      expect(note.noteId).toBe('root');
      expect(note.title).toBe('root');
    });

    it('should call get_note for a note with content (default include_content=true)', async () => {
      const result = await createStdioClient(getTriliumHost());
      client = result.client;
      transport = result.transport;

      // Create a note with known content so we can assert the default
      // include_content=true path returns the body.
      const createResponse = await client.callTool({
        name: 'create_note',
        arguments: {
          parentNoteId: 'root',
          title: 'Default-content Test',
          type: 'text',
          content: '<p>SENTINEL_BODY_42</p>',
        },
      });
      const createdId = JSON.parse(
        (createResponse.content as Array<{ type: string; text: string }>)[0].text
      ).note.noteId as string;

      try {
        const response = await client.callTool({
          name: 'get_note',
          arguments: { noteId: createdId },
        });
        const content = response.content as Array<{ type: string; text: string }>;
        // First (and only) block is the body text — NOT JSON metadata.
        expect(content[0].type).toBe('text');
        expect(content[0].text).toContain('SENTINEL_BODY_42');
      } finally {
        await client
          .callTool({ name: 'delete_note', arguments: { noteId: createdId, action: 'delete' } })
          .catch(() => {});
      }
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

    it('should call get_note for root (metadata path)', async () => {
      const result = await createHttpClient(getTriliumHost());
      client = result.client;
      transport = result.transport;
      serverProcess = result.serverProcess;

      const response = await client.callTool({
        name: 'get_note',
        arguments: { noteId: 'root', include_content: false },
      });
      const content = response.content as Array<{ type: string; text: string }>;
      const note = JSON.parse(content[0].text);

      expect(note.noteId).toBe('root');
    });

    it('should call get_note with default include_content=true (body path)', async () => {
      const result = await createHttpClient(getTriliumHost());
      client = result.client;
      transport = result.transport;
      serverProcess = result.serverProcess;

      const createResponse = await client.callTool({
        name: 'create_note',
        arguments: {
          parentNoteId: 'root',
          title: 'SSE Default-content Test',
          type: 'text',
          content: '<p>SSE_SENTINEL_BODY</p>',
        },
      });
      const createdId = JSON.parse(
        (createResponse.content as Array<{ type: string; text: string }>)[0].text
      ).note.noteId as string;

      try {
        const response = await client.callTool({
          name: 'get_note',
          arguments: { noteId: createdId },
        });
        const content = response.content as Array<{ type: string; text: string }>;
        expect(content[0].type).toBe('text');
        expect(content[0].text).toContain('SSE_SENTINEL_BODY');
      } finally {
        await client
          .callTool({ name: 'delete_note', arguments: { noteId: createdId, action: 'delete' } })
          .catch(() => {});
      }
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

  /**
   * Full tool-surface coverage over the legacy SSE transport (/sse + /message).
   * One server + one client are shared across the whole block so the suite
   * stays under the 60s test timeout; each test cleans up the notes it creates.
   *
   * Mirrors what stdio gets but covers the categories stdio doesn't (write
   * modes, attributes, revisions, organize, calendar, tree, history). If a tool
   * doesn't speak across SSE, this block will surface it.
   */
  describe('HTTP/SSE Transport — full tool surface', () => {
    let client: Client;
    let transport: SSEClientTransport;
    let serverProcess: ChildProcess;

    beforeAll(async () => {
      const result = await createHttpClient(getTriliumHost());
      client = result.client;
      transport = result.transport;
      serverProcess = result.serverProcess;
    }, 30_000);

    afterAll(async () => {
      if (client) await cleanup(client, transport, serverProcess);
    });

    /** Helper: create a text note under root and return its noteId. */
    async function makeNote(title: string, body: string): Promise<string> {
      const response = await client.callTool({
        name: 'create_note',
        arguments: { parentNoteId: 'root', title, type: 'text', content: body },
      });
      return parseJsonResponse<{ note: { noteId: string } }>(response).note.noteId;
    }

    async function deleteNote(noteId: string): Promise<void> {
      await client
        .callTool({ name: 'delete_note', arguments: { noteId, action: 'delete' } })
        .catch(() => {});
    }

    it('get_note default returns the note body', async () => {
      const noteId = await makeNote('SSE default-content body', '<p>SSE_BODY_OK</p>');
      try {
        const response = await client.callTool({ name: 'get_note', arguments: { noteId } });
        const content = response.content as Array<{ type: string; text: string }>;
        expect(content[0].type).toBe('text');
        expect(content[0].text).toContain('SSE_BODY_OK');
      } finally {
        await deleteNote(noteId);
      }
    });

    it('get_note with include_content=false returns metadata only', async () => {
      const noteId = await makeNote('SSE metadata-only', '<p>ignored</p>');
      try {
        const response = await client.callTool({
          name: 'get_note',
          arguments: { noteId, include_content: false },
        });
        const meta = parseJsonResponse<{ noteId: string; title: string }>(response);
        expect(meta.noteId).toBe(noteId);
        expect(meta.title).toBe('SSE metadata-only');
      } finally {
        await deleteNote(noteId);
      }
    });

    it('write_note mode="metadata" updates title', async () => {
      const noteId = await makeNote('SSE rename-me', '<p>x</p>');
      try {
        await client.callTool({
          name: 'write_note',
          arguments: { noteId, mode: 'metadata', title: 'SSE renamed' },
        });
        const response = await client.callTool({
          name: 'get_note',
          arguments: { noteId, include_content: false },
        });
        const meta = parseJsonResponse<{ title: string }>(response);
        expect(meta.title).toBe('SSE renamed');
      } finally {
        await deleteNote(noteId);
      }
    });

    it('write_note mode="replace" overwrites content', async () => {
      const noteId = await makeNote('SSE replace target', '<p>original</p>');
      try {
        await client.callTool({
          name: 'write_note',
          arguments: { noteId, mode: 'replace', content: '<p>REPLACED</p>' },
        });
        const response = await client.callTool({ name: 'get_note', arguments: { noteId } });
        const body = (response.content as Array<{ type: string; text: string }>)[0].text;
        expect(body).toContain('REPLACED');
        expect(body).not.toContain('original');
      } finally {
        await deleteNote(noteId);
      }
    });

    it('write_note mode="append" concatenates content', async () => {
      const noteId = await makeNote('SSE append target', '<p>FIRST</p>');
      try {
        await client.callTool({
          name: 'write_note',
          arguments: { noteId, mode: 'append', content: '<p>SECOND</p>' },
        });
        const response = await client.callTool({ name: 'get_note', arguments: { noteId } });
        const body = (response.content as Array<{ type: string; text: string }>)[0].text;
        expect(body).toContain('FIRST');
        expect(body).toContain('SECOND');
      } finally {
        await deleteNote(noteId);
      }
    });

    it('write_note mode="edit" applies a search/replace block', async () => {
      const noteId = await makeNote('SSE edit target', '<p>hello world</p>');
      try {
        await client.callTool({
          name: 'write_note',
          arguments: {
            noteId,
            mode: 'edit',
            changes: [{ old_string: 'hello world', new_string: 'goodbye world' }],
          },
        });
        const response = await client.callTool({ name: 'get_note', arguments: { noteId } });
        const body = (response.content as Array<{ type: string; text: string }>)[0].text;
        expect(body).toContain('goodbye world');
        expect(body).not.toContain('hello world');
      } finally {
        await deleteNote(noteId);
      }
    });

    it('set_attribute upserts a label and get_attributes reads it back', async () => {
      const noteId = await makeNote('SSE attr target', '<p>x</p>');
      try {
        await client.callTool({
          name: 'set_attribute',
          arguments: { noteId, type: 'label', name: 'sseTag', value: 'one' },
        });
        const listResp = await client.callTool({ name: 'get_attributes', arguments: { noteId } });
        const list = parseJsonResponse<{
          labels: Array<{ name: string; value: string }>;
        }>(listResp);
        expect(list.labels.some((l) => l.name === 'sseTag' && l.value === 'one')).toBe(true);
      } finally {
        await deleteNote(noteId);
      }
    });

    it('delete_attribute removes a previously-set label', async () => {
      const noteId = await makeNote('SSE attr-delete target', '<p>x</p>');
      try {
        await client.callTool({
          name: 'set_attribute',
          arguments: { noteId, type: 'label', name: 'ephemeral', value: 'gone' },
        });
        const listResp = await client.callTool({ name: 'get_attributes', arguments: { noteId } });
        const list = parseJsonResponse<{
          labels: Array<{ attributeId: string; name: string }>;
        }>(listResp);
        const target = list.labels.find((l) => l.name === 'ephemeral');
        expect(target).toBeDefined();
        await client.callTool({
          name: 'delete_attribute',
          arguments: { attributeId: target!.attributeId },
        });
        const after = parseJsonResponse<{ labels: Array<{ name: string }> }>(
          await client.callTool({ name: 'get_attributes', arguments: { noteId } })
        );
        expect(after.labels.some((l) => l.name === 'ephemeral')).toBe(false);
      } finally {
        await deleteNote(noteId);
      }
    });

    // Revisions and note-history endpoints (/notes/{id}/revisions,
    // /revisions/{id}, /notes/history) are not exposed by the
    // triliumnext/notes:latest test container's ETAPI router, so any test
    // that round-trips them gets "Router not found" from Trilium. The
    // corresponding handlers ARE covered by tests/unit/tools.test.ts with
    // mocks. Re-enable once the test container ships those routes.
    it.skip('create_revision + get_revisions list and content roundtrip', async () => {});

    it('organize_note moves a note to a new parent', async () => {
      const parentA = await makeNote('SSE parent A', '<p>a</p>');
      const parentB = await makeNote('SSE parent B', '<p>b</p>');
      const child = await client.callTool({
        name: 'create_note',
        arguments: {
          parentNoteId: parentA,
          title: 'SSE moving child',
          type: 'text',
          content: '<p>c</p>',
        },
      });
      const childId = parseJsonResponse<{ note: { noteId: string } }>(child).note.noteId;
      try {
        await client.callTool({
          name: 'organize_note',
          arguments: { action: 'move', noteId: childId, newParentNoteId: parentB },
        });
        const meta = parseJsonResponse<{ parentNoteIds: string[] }>(
          await client.callTool({
            name: 'get_note',
            arguments: { noteId: childId, include_content: false },
          })
        );
        expect(meta.parentNoteIds).toContain(parentB);
        expect(meta.parentNoteIds).not.toContain(parentA);
      } finally {
        await deleteNote(childId);
        await deleteNote(parentA);
        await deleteNote(parentB);
      }
    });

    it('get_special_note returns the daily journal note', async () => {
      const response = await client.callTool({
        name: 'get_special_note',
        arguments: { kind: 'day', date: '2024-01-15' },
      });
      const note = parseJsonResponse<{ noteId: string; title: string }>(response);
      expect(note.noteId).toBeTruthy();
      expect(typeof note.title).toBe('string');
    });

    it('get_note_tree returns root children with childNoteIds populated', async () => {
      const response = await client.callTool({
        name: 'get_note_tree',
        arguments: { noteId: 'root' },
      });
      const tree = parseJsonResponse<{ noteId: string; childNoteIds: string[] }>(response);
      expect(tree.noteId).toBe('root');
      expect(Array.isArray(tree.childNoteIds)).toBe(true);
    });

    // /notes/history is not exposed by the test container's ETAPI router
    // (Router not found). Unit-tested with mocks in tests/unit/tools.test.ts.
    it.skip('get_note_history returns an array of recent changes', async () => {});

    it('search_notes finds a note by a unique title token', async () => {
      const token = `ssetoken${Date.now()}`;
      const noteId = await makeNote(`Findable ${token}`, '<p>x</p>');
      try {
        const response = await client.callTool({
          name: 'search_notes',
          arguments: { query: token },
        });
        const result = parseJsonResponse<{ results: Array<{ noteId: string }> }>(response);
        expect(result.results.some((n) => n.noteId === noteId)).toBe(true);
      } finally {
        await deleteNote(noteId);
      }
    });

    it('get_attachment default returns text body for a text attachment', async () => {
      const noteId = await makeNote('SSE attach-text owner', '<p>x</p>');
      try {
        const attach = parseJsonResponse<{ attachmentId: string }>(
          await client.callTool({
            name: 'create_attachment',
            arguments: {
              ownerId: noteId,
              role: 'file',
              mime: 'text/plain',
              title: 'note.txt',
              content: 'attachment-payload',
            },
          })
        );
        // Default include_content=true → text block.
        const response = await client.callTool({
          name: 'get_attachment',
          arguments: { attachmentId: attach.attachmentId },
        });
        const content = response.content as Array<{ type: string; text: string }>;
        expect(content[0].type).toBe('text');
        expect(content[0].text).toBe('attachment-payload');
      } finally {
        await deleteNote(noteId);
      }
    });

    it('get_attachment returns image block by default for image MIME', async () => {
      const noteId = await makeNote('SSE attach-image owner', '<p>x</p>');
      try {
        const pngBase64 =
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const attach = parseJsonResponse<{ attachmentId: string }>(
          await client.callTool({
            name: 'create_attachment',
            arguments: {
              ownerId: noteId,
              role: 'image',
              mime: 'image/png',
              title: 'pixel.png',
              content: pngBase64,
            },
          })
        );
        const response = await client.callTool({
          name: 'get_attachment',
          arguments: { attachmentId: attach.attachmentId },
        });
        const content = response.content as Array<{
          type: string;
          data?: string;
          mimeType?: string;
        }>;
        expect(content[0].type).toBe('image');
        expect(content[0].mimeType).toBe('image/png');
        expect(content[0].data).toBe(pngBase64);
      } finally {
        await deleteNote(noteId);
      }
    });

    it('write_attachment edit mode applies search/replace on text content', async () => {
      const noteId = await makeNote('SSE attach-edit owner', '<p>x</p>');
      try {
        const attach = parseJsonResponse<{ attachmentId: string }>(
          await client.callTool({
            name: 'create_attachment',
            arguments: {
              ownerId: noteId,
              role: 'file',
              mime: 'text/plain',
              title: 'editable.txt',
              content: 'one two three',
            },
          })
        );
        await client.callTool({
          name: 'write_attachment',
          arguments: {
            attachmentId: attach.attachmentId,
            mode: 'edit',
            changes: [{ old_string: 'two', new_string: 'TWO' }],
          },
        });
        const response = await client.callTool({
          name: 'get_attachment',
          arguments: { attachmentId: attach.attachmentId },
        });
        const content = response.content as Array<{ type: string; text: string }>;
        expect(content[0].text).toBe('one TWO three');
      } finally {
        await deleteNote(noteId);
      }
    });

    it('manage_system export returns a base64 ZIP for a subtree', async () => {
      const noteId = await makeNote('SSE export source', '<p>exported body</p>');
      try {
        const response = await client.callTool({
          name: 'manage_system',
          arguments: { action: 'export', noteId, format: 'markdown' },
        });
        const result = parseJsonResponse<{
          action: string;
          base64Data: string;
          sizeBytes: number;
        }>(response);
        expect(result.action).toBe('export');
        expect(result.sizeBytes).toBeGreaterThan(0);
        expect(result.base64Data.length).toBeGreaterThan(0);
      } finally {
        await deleteNote(noteId);
      }
    });

    // /notes/{id}/undelete is not exposed by the test container's ETAPI
    // router. Unit-tested with mocks in tests/unit/tools.test.ts.
    it.skip('delete_note action="undelete" restores a soft-deleted note', async () => {});
  });

  /**
   * Coverage for the StreamableHTTP transport (/mcp endpoint). It shares the
   * same MCP server build as SSE so this block focuses on transport-level
   * parity rather than re-running every tool. If sessions, request body
   * decoding, or the message envelope diverged from SSE, the canonical
   * operations here would catch it.
   */
  describe('StreamableHTTP Transport — parity coverage', () => {
    let client: Client;
    let transport: StreamableHTTPClientTransport;
    let serverProcess: ChildProcess;

    beforeAll(async () => {
      const result = await createStreamableHttpClient(getTriliumHost());
      client = result.client;
      transport = result.transport;
      serverProcess = result.serverProcess;
    }, 30_000);

    afterAll(async () => {
      if (client) await cleanup(client, transport, serverProcess);
    });

    it('list_tools returns the full tool surface', async () => {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(EXPECTED_TOOL_COUNT);
      expect(tools.tools.map((t) => t.name)).toContain('get_note');
    });

    it('get_note default returns body; include_content=false returns metadata', async () => {
      const createResponse = await client.callTool({
        name: 'create_note',
        arguments: {
          parentNoteId: 'root',
          title: 'Streamable body roundtrip',
          type: 'text',
          content: '<p>STREAMABLE_BODY</p>',
        },
      });
      const noteId = parseJsonResponse<{ note: { noteId: string } }>(createResponse).note
        .noteId;
      try {
        const defaultResponse = await client.callTool({
          name: 'get_note',
          arguments: { noteId },
        });
        const defaultContent = defaultResponse.content as Array<{ type: string; text: string }>;
        expect(defaultContent[0].text).toContain('STREAMABLE_BODY');

        const metaResponse = await client.callTool({
          name: 'get_note',
          arguments: { noteId, include_content: false },
        });
        const meta = parseJsonResponse<{ noteId: string; title: string }>(metaResponse);
        expect(meta.noteId).toBe(noteId);
        expect(meta.title).toBe('Streamable body roundtrip');
      } finally {
        await client
          .callTool({ name: 'delete_note', arguments: { noteId, action: 'delete' } })
          .catch(() => {});
      }
    });

    it('write_note edit + get_attachment image roundtrip', async () => {
      const noteId = parseJsonResponse<{ note: { noteId: string } }>(
        await client.callTool({
          name: 'create_note',
          arguments: {
            parentNoteId: 'root',
            title: 'Streamable mixed roundtrip',
            type: 'text',
            content: '<p>before</p>',
          },
        })
      ).note.noteId;

      try {
        // Edit body via search/replace.
        await client.callTool({
          name: 'write_note',
          arguments: {
            noteId,
            mode: 'edit',
            changes: [{ old_string: 'before', new_string: 'AFTER' }],
          },
        });
        const body = (
          (await client.callTool({ name: 'get_note', arguments: { noteId } }))
            .content as Array<{ type: string; text: string }>
        )[0].text;
        expect(body).toContain('AFTER');

        // Attach an image and read it back as an image block.
        const pngBase64 =
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const attach = parseJsonResponse<{ attachmentId: string }>(
          await client.callTool({
            name: 'create_attachment',
            arguments: {
              ownerId: noteId,
              role: 'image',
              mime: 'image/png',
              title: 'streamable.png',
              content: pngBase64,
            },
          })
        );
        const imageResponse = await client.callTool({
          name: 'get_attachment',
          arguments: { attachmentId: attach.attachmentId },
        });
        const content = imageResponse.content as Array<{
          type: string;
          mimeType?: string;
          data?: string;
        }>;
        expect(content[0].type).toBe('image');
        expect(content[0].mimeType).toBe('image/png');
      } finally {
        await client
          .callTool({ name: 'delete_note', arguments: { noteId, action: 'delete' } })
          .catch(() => {});
      }
    });

    it('search_notes finds a freshly-created note', async () => {
      const token = `streamtok${Date.now()}`;
      const noteId = parseJsonResponse<{ note: { noteId: string } }>(
        await client.callTool({
          name: 'create_note',
          arguments: {
            parentNoteId: 'root',
            title: `Streamable ${token}`,
            type: 'text',
            content: '<p>x</p>',
          },
        })
      ).note.noteId;
      try {
        const response = await client.callTool({
          name: 'search_notes',
          arguments: { query: token },
        });
        const result = parseJsonResponse<{ results: Array<{ noteId: string }> }>(response);
        expect(result.results.some((r) => r.noteId === noteId)).toBe(true);
      } finally {
        await client
          .callTool({ name: 'delete_note', arguments: { noteId, action: 'delete' } })
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

    it('should return identical tool lists from SSE and StreamableHTTP', async () => {
      const sse = await createHttpClient(getTriliumHost());
      const streamable = await createStreamableHttpClient(getTriliumHost());

      try {
        const sseTools = await sse.client.listTools();
        const streamableTools = await streamable.client.listTools();

        const sseNames = sseTools.tools.map((t) => t.name).sort();
        const streamableNames = streamableTools.tools.map((t) => t.name).sort();

        expect(sseNames).toEqual(streamableNames);
        expect(sseNames).toHaveLength(EXPECTED_TOOL_COUNT);
      } finally {
        await cleanup(sse.client, sse.transport, sse.serverProcess);
        await cleanup(streamable.client, streamable.transport, streamable.serverProcess);
      }
    });
  });
});
