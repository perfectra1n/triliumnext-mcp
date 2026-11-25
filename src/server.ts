import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';

import { TriliumClient, TriliumClientError, clientOptionsFromConfig } from './client/trilium.js';
import {
  formatTriliumError,
  formatZodError,
  formatDiffError,
  formatContentInputError,
  formatUnknownError,
  formatErrorForMCP,
} from './errors/index.js';
import { DiffApplicationError } from './tools/diff.js';
import { configureContentInput, ContentNormalizationError } from './tools/contentInput.js';
import type { Config } from './config.js';
import type { ToolHandlerResult } from './tools/schemas.js';
import type { ToolContext } from './tools/context.js';
import { deriveWebBaseUrl, TUNABLE_DEFAULTS } from './config.js';
import { SERVER_INSTRUCTIONS } from './server-instructions.js';
import { SERVER_VERSION } from './version.js';
import { registerNoteTools, handleNoteTool, configureNoteTools } from './tools/notes.js';
import { registerSearchTools, handleSearchTool, configureSearch } from './tools/search.js';
import { registerOrganizationTools, handleOrganizationTool } from './tools/organization.js';
import { registerAttributeTools, handleAttributeTool } from './tools/attributes.js';
import { registerCalendarTools, handleCalendarTool } from './tools/calendar.js';
import { registerSystemTools, handleSystemTool, configureSystemTools } from './tools/system.js';
import {
  registerAttachmentTools,
  handleAttachmentTool,
  configureAttachmentTools,
} from './tools/attachments.js';
import { configureContentLimits } from './tools/contentLimits.js';
import { registerRevisionTools, handleRevisionTool } from './tools/revisions.js';
import { startHttp } from './http/server.js';
import { redactArgs, type Logger } from './utils/logger.js';
import type { Metrics } from './http/metrics.js';

type ToolHandler = (
  client: TriliumClient,
  name: string,
  args: unknown,
  ctx: ToolContext
) => Promise<ToolHandlerResult>;

/** Each handler returns null for names it does not own; the first non-null result wins. */
const TOOL_HANDLERS: ToolHandler[] = [
  handleNoteTool,
  handleSearchTool,
  handleOrganizationTool,
  handleAttributeTool,
  handleCalendarTool,
  handleSystemTool,
  handleAttachmentTool,
  handleRevisionTool,
];

export interface McpServerContext {
  logger: Logger;
  sessionId: string;
  metrics?: Metrics;
  /**
   * Authenticated principal id (from `gatewayAuth=jwt`). Threaded into
   * tool_call audit logs and, when enabled, into per-tenant metric labels.
   */
  principal?: string;
  /**
   * How often to send a progress heartbeat during a tool call whose request
   * carried a progressToken (default 10s). Clients that reset their request
   * timeout on progress then keep waiting on a slow Trilium instead of giving up.
   */
  progressIntervalMs?: number;
}

/**
 * Builds a fully-configured MCP Server bound to the given Trilium client.
 * One instance per logical connection: in multi-tenant SSE mode each SSE
 * session owns its own Server + client pair so tool handlers cannot see
 * state from other tenants.
 */
export function buildMcpServer(client: TriliumClient, ctx: McpServerContext): Server {
  const {
    logger,
    sessionId,
    metrics,
    principal,
    progressIntervalMs = TUNABLE_DEFAULTS.progressIntervalMs,
  } = ctx;
  const server = new Server(
    {
      name: 'triliumnext-mcp',
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  // Tool order matters: some clients pre-load only the first N tools. Put
  // read-heavy categories first so navigation/search are always available.
  const allTools = [
    ...registerSearchTools(), // search_notes, get_note_tree
    ...registerNoteTools(), // get_note, get_note_history, create_note, write_note, delete_note
    ...registerRevisionTools(), // get_revisions, restore_revision
    ...registerAttributeTools(), // get_attributes, set_attribute, delete_attribute
    ...registerAttachmentTools(), // get_attachment, create_attachment, write_attachment, delete_attachment
    ...registerCalendarTools(), // get_special_note
    ...registerOrganizationTools(), // organize_note
    ...registerSystemTools(), // create_revision, manage_system
  ];

  const toolNames = new Set(allTools.map((t) => t.name));

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
      // Unknown names collapse to one label so arbitrary client input cannot
      // blow up metric cardinality (the log line above keeps the raw name).
      const label = toolNames.has(tool) ? tool : 'unknown';
      const okLabel = outcome.ok ? 'true' : 'false';
      const errorLabel = outcome.ok ? 'none' : (outcome.error ?? 'unknown');
      metrics.toolCallsTotal.inc({ tool: label, ok: okLabel, error: errorLabel });
      metrics.toolCallDuration.observe({ tool: label }, durationMs / 1000);
      if (metrics.toolCallsByPrincipalTotal && principal) {
        metrics.toolCallsByPrincipalTotal.inc({
          principal,
          tool: label,
          ok: okLabel,
          error: errorLabel,
        });
      }
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const t0 = performance.now();

    // MCP progress notifications, only when the client asked with a progressToken.
    const progressToken = request.params._meta?.progressToken;
    let progressCount = 0;
    const progress = (message: string): void => {
      if (progressToken === undefined) return;
      progressCount += 1;
      void extra
        .sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress: progressCount, message },
        })
        .catch(() => undefined);
    };
    const heartbeat =
      progressToken === undefined
        ? undefined
        : setInterval(() => {
            const waited = Math.round((performance.now() - t0) / 1000);
            progress(`Still working on ${name} (${waited}s), waiting for Trilium.`);
          }, progressIntervalMs);
    heartbeat?.unref?.();
    logger.debug('tool_call_args', {
      session: sessionId,
      principal,
      tool: name,
      args: redactArgs(args),
    });

    try {
      for (const handle of TOOL_HANDLERS) {
        const result = await handle(client, name, args, { progress });
        if (result !== null) {
          recordToolCall(name, t0, { ok: true });
          return result;
        }
      }

      recordToolCall(name, t0, { ok: false, error: 'unknown_tool' });
      return {
        content: [
          {
            type: 'text',
            text: `Unknown tool: ${name}. Valid tools: ${[...toolNames].join(', ')}.`,
          },
        ],
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
      } else if (error instanceof ContentNormalizationError) {
        structured = formatContentInputError(error);
        recordToolCall(name, t0, { ok: false, error: 'content_input', code: error.code });
      } else {
        structured = formatUnknownError(error);
        recordToolCall(name, t0, {
          ok: false,
          error: 'unknown',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return formatErrorForMCP(structured);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
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
    config.publicUrl ?? deriveWebBaseUrl(config.triliumUrl),
    clientOptionsFromConfig(config)
  );
  const server = buildMcpServer(client, {
    logger,
    sessionId: 'stdio',
    progressIntervalMs: config.progressIntervalMs,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('server_started', { transport: 'stdio' });
}

/**
 * Apply the process-wide tool settings from config. Must run before any
 * buildMcpServer call: tool descriptions and schemas interpolate these limits
 * at registration time. Unset (undefined) fields keep each module's default.
 */
export function configureTools(config: Config): void {
  // Content-input policy is process-wide: both transports share it, and tool
  // handlers pick it up via the contentInput module rather than a threaded arg.
  configureContentInput({
    allowLocalFileRead: config.allowLocalFileRead,
    localFileRoots: config.localFileRoots,
    // Content URLs are LLM-chosen, so they have their own private-network
    // switch; the fallback mirrors loadConfig for embedders that omit it.
    urlGuard: {
      allowlist: config.contentUrlAllowlist,
      allowPrivate:
        config.contentAllowPrivateUrls ?? (config.multiTenant ? false : config.allowPrivateUrls),
    },
    maxBytes: config.maxContentFetchBytes,
    fetchTimeoutMs: config.contentFetchTimeoutMs ?? TUNABLE_DEFAULTS.contentFetchTimeoutMs,
  });
  // Before configureNoteTools: get_note's schema defaults to the char cap.
  configureContentLimits({ contentCharCap: config.contentCharCap });
  configureNoteTools({
    noteImageMaxBytes: config.maxNoteImageBytes,
    noteImagesTotalMaxBytes: config.maxNoteImagesTotalBytes,
    contentMaxCharsLimit: config.contentMaxCharsLimit,
    maxPaths: config.noteMaxPaths,
    maxBacklinks: config.noteMaxBacklinks,
    historyLimit: config.historyLimit,
    historyMaxLimit: config.historyMaxLimit,
  });
  configureAttachmentTools({ maxInlineAttachmentBytes: config.maxInlineAttachmentBytes });
  configureSystemTools({ maxExportBytes: config.maxExportBytes });
  configureSearch({
    defaultStrategy: config.searchStrategy,
    defaultLimit: config.defaultSearchLimit,
    maxLimit: config.maxSearchLimit,
    fastFirstMinResults: config.searchFastMinResults,
    maxPreviewResults: config.searchPreviewMaxResults,
    fetchConcurrency: config.fetchConcurrency,
    maxTreeNotes: config.treeMaxNotes,
    fuzzyMaxTerms: config.fuzzyMaxTerms,
    fuzzyRecallMultiplier: config.fuzzyRecallMultiplier,
    fuzzyRecallCap: config.fuzzyRecallCap,
  });
}

export async function createServer(config: Config, logger: Logger): Promise<void> {
  configureTools(config);

  if (config.transport === 'stdio') {
    await startStdio(config, logger);
  } else {
    await startHttp(config, logger);
  }
}
