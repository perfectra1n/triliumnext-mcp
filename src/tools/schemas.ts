import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

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
