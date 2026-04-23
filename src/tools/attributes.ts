import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import type { AttributeType } from '../types/etapi.js';
import { defineTool } from './schemas.js';
import {
  attributeTypeSchema,
  optionalEntityIdSchema,
  positionSchema,
  required,
} from './validators.js';

const getAttributesSchema = z
  .object({
    noteId: z
      .string()
      .optional()
      .describe('If provided, returns all attributes of this note grouped by type (labels, relations).'),
    attributeId: z
      .string()
      .optional()
      .describe('If provided, returns the single attribute with this ID (noteId, type, name, value, position).'),
  })
  .check((ctx) => {
    const { noteId, attributeId } = ctx.value;
    const provided = [noteId !== undefined, attributeId !== undefined].filter(Boolean).length;
    if (provided === 0) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Exactly one of "noteId" or "attributeId" is required',
        path: [],
      });
    } else if (provided > 1) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Provide either "noteId" or "attributeId", not both',
        path: [],
      });
    }
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
      'Get attributes of a note (all, grouped by type) or a single attribute by ID. ' +
        'Pass "noteId" to list all attributes on that note (labels + relations). ' +
        'Pass "attributeId" to fetch one specific attribute. Exactly one is required.',
      getAttributesSchema,
      { title: 'Get attributes', readOnlyHint: true }
    ),
    defineTool(
      'set_attribute',
      'Add or update an attribute on a note (upsert). For labels, value is the label value. ' +
        'For relations, value is the target noteId. If the attribute (noteId+type+name) already exists, ' +
        'its value/position are updated; otherwise a new attribute is created.',
      setAttributeSchema,
      {
        title: 'Set attribute (upsert)',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      }
    ),
    defineTool(
      'delete_attribute',
      'Remove an attribute from a note by its attribute ID.',
      deleteAttributeSchema,
      {
        title: 'Delete attribute',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      }
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

      if (parsed.attributeId) {
        const attr = await client.getAttribute(parsed.attributeId);
        return {
          content: [{ type: 'text', text: JSON.stringify(attr, null, 2) }],
        };
      }

      const noteId = required(parsed.noteId, 'noteId');
      const note = await client.getNote(noteId);
      const labels = note.attributes.filter((a) => a.type === 'label');
      const relations = note.attributes.filter((a) => a.type === 'relation');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ noteId, labels, relations }, null, 2),
          },
        ],
      };
    }

    case 'set_attribute': {
      const parsed = setAttributeSchema.parse(args);

      let existingAttr = null;
      if (!parsed.attributeId) {
        const note = await client.getNote(parsed.noteId);
        existingAttr = note.attributes.find(
          (a) => a.type === parsed.type && a.name === parsed.name
        );
      }

      let result;
      if (existingAttr) {
        result = await client.updateAttribute(existingAttr.attributeId, {
          value: parsed.value,
          position: parsed.position,
        });
      } else {
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
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, attributeId: parsed.attributeId }, null, 2),
          },
        ],
      };
    }

    default:
      return null;
  }
}
