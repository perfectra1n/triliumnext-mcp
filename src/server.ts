import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';

import { TriliumClient, TriliumClientError } from './client/trilium.js';
import {
  formatTriliumError,
  formatZodError,
  formatUnknownError,
  formatErrorForMCP,
} from './errors/index.js';
import type { Config } from './config.js';
import { registerNoteTools, handleNoteTool } from './tools/notes.js';
import { registerSearchTools, handleSearchTool } from './tools/search.js';
import { registerOrganizationTools, handleOrganizationTool } from './tools/organization.js';
import { registerAttributeTools, handleAttributeTool } from './tools/attributes.js';
import { registerCalendarTools, handleCalendarTool } from './tools/calendar.js';
import { registerSystemTools, handleSystemTool } from './tools/system.js';
import { registerAttachmentTools, handleAttachmentTool } from './tools/attachments.js';

export async function createServer(config: Config): Promise<void> {
  const client = new TriliumClient(config.triliumUrl, config.triliumToken);

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

  // Collect all tools
  const allTools = [
    ...registerNoteTools(),
    ...registerSearchTools(),
    ...registerOrganizationTools(),
    ...registerAttributeTools(),
    ...registerCalendarTools(),
    ...registerSystemTools(),
    ...registerAttachmentTools(),
  ];

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allTools };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // Try each tool category
      let result = await handleNoteTool(client, name, args);
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

      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    } catch (error) {
      // Format errors with structured information and actionable guidance
      let structured;
      if (error instanceof TriliumClientError) {
        structured = formatTriliumError(error);
      } else if (error instanceof ZodError) {
        structured = formatZodError(error, name);
      } else {
        structured = formatUnknownError(error);
      }
      return formatErrorForMCP(structured);
    }
  });

  // Start the appropriate transport
  if (config.transport === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else {
    // HTTP transport - to be implemented
    // For now, we'll use SSE transport from MCP SDK
    const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
    const http = await import('node:http');

    const httpServer = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/sse') {
        const transport = new SSEServerTransport('/message', res);
        await server.connect(transport);
      } else if (req.method === 'POST' && req.url === '/message') {
        // Handle incoming messages - SSE transport processes them internally
        req.on('data', () => {
          // Data consumed by SSE transport
        });
        req.on('end', () => {
          res.writeHead(200);
          res.end();
        });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    httpServer.listen(config.httpPort, () => {
      console.error(`TriliumNext MCP server listening on port ${config.httpPort}`);
    });
  }
}
