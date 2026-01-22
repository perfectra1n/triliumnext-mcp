import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Creates a tool definition from a Zod schema.
 * This provides a single source of truth for both validation and JSON Schema generation.
 *
 * Uses Zod 4's built-in toJSONSchema() method for conversion.
 *
 * @param name - The tool name (e.g., "create_note")
 * @param description - Tool description shown to LLMs
 * @param schema - Zod object schema for input validation
 * @returns Tool definition compatible with MCP SDK
 */
export function defineTool(
  name: string,
  description: string,
  schema: z.ZodObject<z.ZodRawShape>
): Tool {
  // Use Zod 4's built-in JSON Schema conversion
  const jsonSchema = schema.toJSONSchema({ unrepresentable: 'any', reused: 'inline' }) as Record<
    string,
    unknown
  >;

  // Remove $schema and additionalProperties to match MCP SDK expectations
  delete jsonSchema.$schema;
  delete jsonSchema.additionalProperties;

  // Ensure required is always an array (empty if no required fields)
  if (!jsonSchema.required) {
    jsonSchema.required = [];
  }

  return {
    name,
    description,
    inputSchema: jsonSchema as {
      type: 'object';
      properties: { [x: string]: object };
      required?: string[];
    },
  };
}

/**
 * Creates multiple tool definitions from an array of tool configs
 */
export function defineTools(
  tools: Array<{
    name: string;
    description: string;
    schema: z.ZodObject<z.ZodRawShape>;
  }>
): Tool[] {
  return tools.map(({ name, description, schema }) => defineTool(name, description, schema));
}
