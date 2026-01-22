import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ChildProcess } from 'node:child_process';
import {
  startTriliumContainer,
  stopTriliumContainer,
  waitForTrilium,
  initializeTriliumDatabase,
  getTriliumHost,
} from './setup.js';
import { createStdioClient, createHttpClient, cleanup, EXPECTED_TOOL_COUNT } from './helpers/mcp-server.js';

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
      const created = JSON.parse(createContent[0].text);
      expect(created.note.title).toBe('Stdio Test Note');

      // Delete
      const deleteResponse = await client.callTool({
        name: 'delete_note',
        arguments: { noteId: created.note.noteId },
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
      const created = JSON.parse(createContent[0].text);
      expect(created.note.title).toBe('HTTP Test Note');

      // Delete
      await client.callTool({ name: 'delete_note', arguments: { noteId: created.note.noteId } });
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
      const note = JSON.parse(noteContent[0].text);
      testNoteId = note.note.noteId;

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
        name: 'get_attachment_content',
        arguments: { attachmentId: attachment.attachmentId },
      });

      const content = contentResponse.content as Array<{ type: string; text?: string }>;
      expect(content[0].type).toBe('text');
      expect(content[0].text).toBe('Hello World');

      // Cleanup
      await client.callTool({ name: 'delete_note', arguments: { noteId: testNoteId } });
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
      const note = JSON.parse(noteContent[0].text);
      testNoteId = note.note.noteId;

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
        name: 'get_attachment_content',
        arguments: { attachmentId: attachment.attachmentId },
      });

      const content = contentResponse.content as Array<{ type: string; data?: string; mimeType?: string }>;
      expect(content[0].type).toBe('image');
      expect(content[0].data).toBe(pngBase64);
      expect(content[0].mimeType).toBe('image/png');

      // Cleanup
      await client.callTool({ name: 'delete_note', arguments: { noteId: testNoteId } });
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
      const note = JSON.parse(noteContent[0].text);
      testNoteId = note.note.noteId;

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
        name: 'get_attachment_content',
        arguments: { attachmentId: attachment.attachmentId },
      });

      const content = contentResponse.content as Array<{ type: string; data?: string; mimeType?: string }>;
      expect(content[0].type).toBe('image');
      expect(content[0].mimeType).toBe('image/jpeg');

      // Cleanup
      await client.callTool({ name: 'delete_note', arguments: { noteId: testNoteId } });
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
