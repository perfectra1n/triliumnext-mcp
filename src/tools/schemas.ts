import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** Content blocks the tool handlers return (a subset of MCP CallToolResult content). */
export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } };

/**
 * Return shape shared by every `handle*Tool` dispatcher (`null` = not this
 * module's tool). `isError` marks a partial failure reported as data (e.g. a
 * note was created but its attachments failed) rather than thrown.
 */
export type ToolHandlerResult = { content: ToolContentBlock[]; isError?: boolean } | null;

/**
 * MCP tool annotations as hints for clients. None of these affect tool
 * load priority in any current client, but they do improve approval-dialog
 * UX (`destructiveHint`/`readOnlyHint`) and retry behavior (`idempotentHint`).
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Creates a tool definition from a Zod schema.
 *
 * MCP's Tool `inputSchema` must be `type: "object"`, so only top-level
 * `ZodObject` schemas are accepted. For tools that branch on a mode/action
 * field, use a flat object with an enum discriminator and `.check()` for
 * cross-field validation — the JSON Schema stays a single object and the
 * LLM sees one flat parameter list.
 */
export function defineTool(
  name: string,
  description: string,
  schema: z.ZodObject<z.ZodRawShape>,
  annotations?: ToolAnnotations
): Tool {
  // io: 'input' emits input-type semantics: fields with .default() are optional
  // for callers (and carry a `default` keyword) instead of being marked required.
  const jsonSchema = schema.toJSONSchema({
    unrepresentable: 'any',
    reused: 'inline',
    io: 'input',
  }) as Record<string, unknown>;

  delete jsonSchema.$schema;
  delete jsonSchema.additionalProperties;

  if (!jsonSchema.required) {
    jsonSchema.required = [];
  }

  const tool: Tool = {
    name,
    description,
    inputSchema: jsonSchema as {
      type: 'object';
      properties: { [x: string]: object };
      required?: string[];
    },
  };

  if (annotations) {
    tool.annotations = annotations;
    // MCP 2025-06-18 added a top-level display title; mirror the annotation
    // so newer clients pick it up without reading annotations.
    if (annotations.title) {
      tool.title = annotations.title;
    }
  }

  return tool;
}

/**
 * Creates multiple tool definitions from an array of tool configs.
 */
export function defineTools(
  tools: Array<{
    name: string;
    description: string;
    schema: z.ZodObject<z.ZodRawShape>;
    annotations?: ToolAnnotations;
  }>
): Tool[] {
  return tools.map(({ name, description, schema, annotations }) =>
    defineTool(name, description, schema, annotations)
  );
}
