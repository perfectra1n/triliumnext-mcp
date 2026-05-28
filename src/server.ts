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
import { deriveWebBaseUrl } from './config.js';
import { registerNoteTools, handleNoteTool } from './tools/notes.js';
import { registerSearchTools, handleSearchTool } from './tools/search.js';
import { registerOrganizationTools, handleOrganizationTool } from './tools/organization.js';
import { registerAttributeTools, handleAttributeTool } from './tools/attributes.js';
import { registerCalendarTools, handleCalendarTool } from './tools/calendar.js';
import { registerSystemTools, handleSystemTool } from './tools/system.js';
import { registerAttachmentTools, handleAttachmentTool } from './tools/attachments.js';
import { registerRevisionTools, handleRevisionTool } from './tools/revisions.js';
import { startHttp } from './http/server.js';
import { redactArgs, type Logger } from './utils/logger.js';
import type { Metrics } from './http/metrics.js';

export interface McpServerContext {
  logger: Logger;
  sessionId: string;
  metrics?: Metrics;
  /**
   * Authenticated principal id (from `gatewayAuth=jwt`). Threaded into
   * tool_call audit logs and, when enabled, into per-tenant metric labels.
   */
  principal?: string;
}

/**
 * Builds a fully-configured MCP Server bound to the given Trilium client.
 * One instance per logical connection: in multi-tenant SSE mode each SSE
 * session owns its own Server + client pair so tool handlers cannot see
 * state from other tenants.
 */
export function buildMcpServer(client: TriliumClient, ctx: McpServerContext): Server {
  const { logger, sessionId, metrics, principal } = ctx;
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

  // Tool order matters: some clients pre-load only the first N tools. Put
  // read-heavy categories first so navigation/search are always available.
  const allTools = [
    ...registerSearchTools(),       // search_notes, get_note_tree
    ...registerNoteTools(),          // get_note, get_note_history, create_note, write_note, delete_note
    ...registerRevisionTools(),      // get_revisions
    ...registerAttributeTools(),     // get_attributes, set_attribute, delete_attribute
    ...registerAttachmentTools(),    // get_attachment, create_attachment, write_attachment, delete_attachment
    ...registerCalendarTools(),      // get_special_note
    ...registerOrganizationTools(),  // organize_note
    ...registerSystemTools(),        // create_revision, manage_system
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.info('list_tools', { session: sessionId, principal, count: allTools.length });
    return { tools: allTools };
  });

  const recordToolCall = (
    tool: string,
    t0: number,
    outcome: { ok: boolean; error?: string; status?: number; code?: string; message?: string }
  ): void => {
    const durationMs = performance.now() - t0;
    logger.info('tool_call', {
      session: sessionId,
      principal,
      tool,
      duration_ms: Math.round(durationMs),
      ok: outcome.ok,
      error: outcome.error,
      status: outcome.status,
      code: outcome.code,
      message: outcome.message,
    });
    if (metrics) {
      const okLabel = outcome.ok ? 'true' : 'false';
      const errorLabel = outcome.ok ? 'none' : (outcome.error ?? 'unknown');
      metrics.toolCallsTotal.inc({ tool, ok: okLabel, error: errorLabel });
      metrics.toolCallDuration.observe({ tool }, durationMs / 1000);
      if (metrics.toolCallsByPrincipalTotal && principal) {
        metrics.toolCallsByPrincipalTotal.inc({ principal, tool, ok: okLabel, error: errorLabel });
      }
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const t0 = performance.now();
    logger.debug('tool_call_args', { session: sessionId, principal, tool: name, args: redactArgs(args) });

    try {
      let result: {
        content: Array<
          | { type: 'text'; text: string }
          | { type: 'image'; data: string; mimeType: string }
        >;
      } | null = await handleNoteTool(client, name, args);
      if (result !== null) {
        recordToolCall(name, t0, { ok: true });
        return result;
      }

      result = await handleSearchTool(client, name, args);
      if (result !== null) {
        recordToolCall(name, t0, { ok: true });
        return result;
      }

      result = await handleOrganizationTool(client, name, args);
      if (result !== null) {
        recordToolCall(name, t0, { ok: true });
        return result;
      }

      result = await handleAttributeTool(client, name, args);
      if (result !== null) {
        recordToolCall(name, t0, { ok: true });
        return result;
      }

      result = await handleCalendarTool(client, name, args);
      if (result !== null) {
        recordToolCall(name, t0, { ok: true });
        return result;
      }

      result = await handleSystemTool(client, name, args);
      if (result !== null) {
        recordToolCall(name, t0, { ok: true });
        return result;
      }

      result = await handleAttachmentTool(client, name, args);
      if (result !== null) {
        recordToolCall(name, t0, { ok: true });
        return result;
      }

      result = await handleRevisionTool(client, name, args);
      if (result !== null) {
        recordToolCall(name, t0, { ok: true });
        return result;
      }

      recordToolCall(name, t0, { ok: false, error: 'unknown_tool' });
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    } catch (error) {
      let structured;
      if (error instanceof TriliumClientError) {
        structured = formatTriliumError(error);
        recordToolCall(name, t0, {
          ok: false,
          error: 'trilium',
          status: error.status,
          code: error.code,
        });
      } else if (error instanceof ZodError) {
        structured = formatZodError(error, name);
        recordToolCall(name, t0, { ok: false, error: 'zod' });
      } else if (error instanceof DiffApplicationError) {
        structured = formatDiffError(error);
        recordToolCall(name, t0, { ok: false, error: 'diff' });
      } else {
        structured = formatUnknownError(error);
        recordToolCall(name, t0, {
          ok: false,
          error: 'unknown',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return formatErrorForMCP(structured);
    }
  });

  return server;
}

async function startStdio(config: Config, logger: Logger): Promise<void> {
  if (!config.triliumUrl || !config.triliumToken) {
    // Unreachable: loadConfig enforces this invariant for stdio. Defensive.
    throw new Error('stdio transport requires TRILIUM_URL and TRILIUM_TOKEN');
  }
  const client = new TriliumClient(
    config.triliumUrl,
    config.triliumToken,
    config.publicUrl ?? deriveWebBaseUrl(config.triliumUrl)
  );
  const server = buildMcpServer(client, { logger, sessionId: 'stdio' });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('server_started', { transport: 'stdio' });
}

export async function createServer(config: Config, logger: Logger): Promise<void> {
  if (config.transport === 'stdio') {
    await startStdio(config, logger);
  } else {
    await startHttp(config, logger);
  }
}
