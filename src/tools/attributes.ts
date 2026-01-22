import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import type { AttributeType } from '../types/etapi.js';
import { defineTool } from './schemas.js';
import { attributeTypeSchema, optionalEntityIdSchema, positionSchema } from './validators.js';

const getAttributesSchema = z.object({
  noteId: z
    .string()
    .min(1, 'Note ID is required')
    .describe('ID of the note to get attributes from'),
});

const getAttributeSchema = z.object({
  attributeId: z
    .string()
    .min(1, 'Attribute ID is required')
    .describe('ID of the attribute to retrieve'),
});

const setAttributeSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required').describe('ID of the note to set attribute on'),
  type: attributeTypeSchema.describe('Type of attribute'),
  name: z
    .string()
    .min(1, 'Attribute name is required')
    .describe('Name of the attribute (without # or ~)'),
  value: z.string().describe('Value (for labels) or target noteId (for relations)'),
  isInheritable: z.boolean().optional().describe('Whether inherited by child notes'),
  position: positionSchema
    .optional()
    .describe(
      'Position for ordering (10, 20, 30...). Lower = earlier when multiple attributes share a name'
    ),
  attributeId: optionalEntityIdSchema.describe(
    'Force a specific attribute ID (for imports/migrations). Must be 4-32 alphanumeric chars.'
  ),
});

const deleteAttributeSchema = z.object({
  attributeId: z
    .string()
    .min(1, 'Attribute ID is required')
    .describe('ID of the attribute to delete'),
});

export function registerAttributeTools(): Tool[] {
  return [
    defineTool(
      'get_attributes',
      'Get all attributes (labels and relations) of a note. Labels are key-value pairs, relations link to other notes.',
      getAttributesSchema
    ),
    defineTool(
      'get_attribute',
      'Get a single attribute by its ID. Returns the full attribute details including noteId, type, name, value, and position.',
      getAttributeSchema
    ),
    defineTool(
      'set_attribute',
      'Add or update an attribute on a note. For labels, value is the label value. For relations, value is the target noteId.',
      setAttributeSchema
    ),
    defineTool(
      'delete_attribute',
      'Remove an attribute from a note by its attribute ID.',
      deleteAttributeSchema
    ),
  ];
}

export async function handleAttributeTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: 'text'; text: string }> } | null> {
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
