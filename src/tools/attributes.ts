import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import type { AttributeType } from '../types/etapi.js';

const getAttributesSchema = z.object({
  noteId: z.string().describe('ID of the note to get attributes from'),
});

const getAttributeSchema = z.object({
  attributeId: z.string().describe('ID of the attribute to retrieve'),
});

const setAttributeSchema = z.object({
  noteId: z.string().describe('ID of the note to set attribute on'),
  type: z.enum(['label', 'relation']).describe('Type of attribute'),
  name: z.string().describe('Name of the attribute'),
  value: z.string().describe('Value of the attribute (for labels) or target noteId (for relations)'),
  isInheritable: z.boolean().optional().describe('Whether the attribute is inherited by child notes'),
  position: z.number().optional().describe('Position for ordering when multiple attributes have the same name'),
  attributeId: z.string().optional().describe('Force a specific attribute ID (for imports/migrations)'),
});

const deleteAttributeSchema = z.object({
  attributeId: z.string().describe('ID of the attribute to delete'),
});

export function registerAttributeTools(): Tool[] {
  return [
    {
      name: 'get_attributes',
      description: 'Get all attributes (labels and relations) of a note. Labels are key-value pairs, relations link to other notes.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'ID of the note to get attributes from' },
        },
        required: ['noteId'],
      },
    },
    {
      name: 'get_attribute',
      description: 'Get a single attribute by its ID. Returns the full attribute details including noteId, type, name, value, and position.',
      inputSchema: {
        type: 'object',
        properties: {
          attributeId: { type: 'string', description: 'ID of the attribute to retrieve' },
        },
        required: ['attributeId'],
      },
    },
    {
      name: 'set_attribute',
      description: 'Add or update an attribute on a note. For labels, value is the label value. For relations, value is the target noteId.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'ID of the note to set attribute on' },
          type: { type: 'string', enum: ['label', 'relation'], description: 'Type of attribute' },
          name: { type: 'string', description: 'Name of the attribute (without # or ~)' },
          value: { type: 'string', description: 'Value (for labels) or target noteId (for relations)' },
          isInheritable: { type: 'boolean', description: 'Whether inherited by child notes' },
          position: { type: 'number', description: 'Position for ordering (10, 20, 30...). Lower = earlier when multiple attributes share a name' },
          attributeId: { type: 'string', description: 'Force a specific attribute ID (for imports/migrations). Must be 4-32 alphanumeric chars.' },
        },
        required: ['noteId', 'type', 'name', 'value'],
      },
    },
    {
      name: 'delete_attribute',
      description: 'Remove an attribute from a note by its attribute ID.',
      inputSchema: {
        type: 'object',
        properties: {
          attributeId: { type: 'string', description: 'ID of the attribute to delete' },
        },
        required: ['attributeId'],
      },
    },
  ];
}

export async function handleAttributeTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  switch (name) {
    case 'get_attributes': {
      const parsed = getAttributesSchema.parse(args);
      const note = await client.getNote(parsed.noteId);

      // Group attributes by type for easier reading
      const labels = note.attributes.filter((a) => a.type === 'label');
      const relations = note.attributes.filter((a) => a.type === 'relation');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ noteId: parsed.noteId, labels, relations }, null, 2),
          },
        ],
      };
    }

    case 'get_attribute': {
      const parsed = getAttributeSchema.parse(args);
      const result = await client.getAttribute(parsed.attributeId);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'set_attribute': {
      const parsed = setAttributeSchema.parse(args);

      // Check if attribute already exists (unless forcing a specific attributeId)
      let existingAttr = null;
      if (!parsed.attributeId) {
        const note = await client.getNote(parsed.noteId);
        existingAttr = note.attributes.find(
          (a) => a.type === parsed.type && a.name === parsed.name
        );
      }

      let result;
      if (existingAttr) {
        // Update existing attribute
        result = await client.updateAttribute(existingAttr.attributeId, {
          value: parsed.value,
          position: parsed.position,
        });
      } else {
        // Create new attribute
        result = await client.createAttribute({
          noteId: parsed.noteId,
          type: parsed.type as AttributeType,
          name: parsed.name,
          value: parsed.value,
          isInheritable: parsed.isInheritable,
          position: parsed.position,
          attributeId: parsed.attributeId,
        });
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'delete_attribute': {
      const parsed = deleteAttributeSchema.parse(args);
      await client.deleteAttribute(parsed.attributeId);
      return {
        content: [{ type: 'text', text: `Attribute ${parsed.attributeId} deleted successfully` }],
      };
    }

    default:
      return null;
  }
}
