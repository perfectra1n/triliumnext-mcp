import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';

import { TriliumClient, TriliumClientError } from './client/trilium.js';
import {
  formatTriliumError,
  formatZodError,
  formatDiffError,
  formatUnknownError,
  formatErrorForMCP,
} from './errors/index.js';
import { DiffApplicationError } from './tools/diff.js';
import type { Config } from './config.js';
import { registerNoteTools, handleNoteTool } from './tools/notes.js';
import { registerSearchTools, handleSearchTool } from './tools/search.js';
import { registerOrganizationTools, handleOrganizationTool } from './tools/organization.js';
import { registerAttributeTools, handleAttributeTool } from './tools/attributes.js';
import { registerCalendarTools, handleCalendarTool } from './tools/calendar.js';
import { registerSystemTools, handleSystemTool } from './tools/system.js';
import { registerAttachmentTools, handleAttachmentTool } from './tools/attachments.js';
import { registerRevisionTools, handleRevisionTool } from './tools/revisions.js';
import { startHttp } from './http/server.js';

/**
 * Builds a fully-configured MCP Server bound to the given Trilium client.
 * One instance per logical connection: in multi-tenant SSE mode each SSE
 * session owns its own Server + client pair so tool handlers cannot see
 * state from other tenants.
 */
export function buildMcpServer(client: TriliumClient): Server {
  const server = new Server(
    {
      name: 'triliumnext-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const allTools = [
    ...registerNoteTools(),
    ...registerSearchTools(),
    ...registerOrganizationTools(),
    ...registerAttributeTools(),
    ...registerCalendarTools(),
    ...registerSystemTools(),
    ...registerAttachmentTools(),
    ...registerRevisionTools(),
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: {
        content: Array<
          | { type: 'text'; text: string }
          | { type: 'image'; data: string; mimeType: string }
        >;
      } | null = await handleNoteTool(client, name, args);
      if (result !== null) return result;

      result = await handleSearchTool(client, name, args);
      if (result !== null) return result;

      result = await handleOrganizationTool(client, name, args);
      if (result !== null) return result;

      result = await handleAttributeTool(client, name, args);
      if (result !== null) return result;

      result = await handleCalendarTool(client, name, args);
      if (result !== null) return result;

      result = await handleSystemTool(client, name, args);
      if (result !== null) return result;

      result = await handleAttachmentTool(client, name, args);
      if (result !== null) return result;

      result = await handleRevisionTool(client, name, args);
      if (result !== null) return result;

      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    } catch (error) {
      let structured;
      if (error instanceof TriliumClientError) {
        structured = formatTriliumError(error);
      } else if (error instanceof ZodError) {
        structured = formatZodError(error, name);
      } else if (error instanceof DiffApplicationError) {
        structured = formatDiffError(error);
      } else {
        structured = formatUnknownError(error);
      }
      return formatErrorForMCP(structured);
    }
  });

  return server;
}

async function startStdio(config: Config): Promise<void> {
  if (!config.triliumUrl || !config.triliumToken) {
    // Unreachable: loadConfig enforces this invariant for stdio. Defensive.
    throw new Error('stdio transport requires TRILIUM_URL and TRILIUM_TOKEN');
  }
  const client = new TriliumClient(config.triliumUrl, config.triliumToken);
  const server = buildMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function createServer(config: Config): Promise<void> {
  if (config.transport === 'stdio') {
    await startStdio(config);
  } else {
    await startHttp(config);
  }
}
