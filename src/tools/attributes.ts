import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import type { Attribute, AttributeType } from '../types/etapi.js';
import { defineTool, type ToolHandlerResult } from './schemas.js';
import {
  attributeTypeSchema,
  entityIdSchema,
  optionalEntityIdSchema,
  positionSchema,
  required,
} from './validators.js';

const getAttributesSchema = z
  .object({
    noteId: entityIdSchema
      .optional()
      .describe("List this note's own attributes, grouped into labels and relations."),
    attributeId: entityIdSchema
      .optional()
      .describe('Fetch one attribute (noteId, type, name, value, position, isInheritable).'),
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
  noteId: entityIdSchema.describe('Note that owns the attribute.'),
  type: attributeTypeSchema.describe('"label" (#name) or "relation" (~name).'),
  name: z
    .string()
    .min(1, 'Attribute name is required')
    .describe('Attribute name without the leading # or ~.'),
  value: z
    .string()
    .describe(
      'Label value ("" for a valueless label such as #archived), or the target noteId for a relation.'
    ),
  mode: z
    .enum(['upsert', 'add'])
    .default('upsert')
    .describe(
      '"upsert" (default): change the first own attribute with the same type+name, or create one. ' +
        '"add": always create, for repeated labels (e.g. several #tag values). Ignored when attributeId is given.'
    ),
  isInheritable: z
    .boolean()
    .optional()
    .describe(
      'Whether child notes inherit the attribute. On upsert, changing it replaces the attribute ' +
        '(delete + create, new attributeId).'
    ),
  position: positionSchema
    .optional()
    .describe('Ordering among attributes (10, 20, 30...); lower comes first.'),
  attributeId: optionalEntityIdSchema.describe(
    'Force the ID of a newly created attribute (imports/migrations; 4-32 alphanumeric chars). ' +
      'Always creates — it does not select an existing attribute.'
  ),
});

const deleteAttributeSchema = z.object({
  attributeId: entityIdSchema.describe('ID of the attribute to delete (from get_attributes).'),
});

export function registerAttributeTools(): Tool[] {
  return [
    defineTool(
      'get_attributes',
      "Read attributes. Pass noteId for the note's own labels and relations (inherited attributes are " +
        'not included), or attributeId for one attribute. Exactly one is required.',
      getAttributesSchema,
      { title: 'Get attributes', readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    ),
    defineTool(
      'set_attribute',
      'Add or update a label or relation on a note. Upsert (default) edits the first own attribute ' +
        "with the same type+name in place when only a label's value or the position changes. Trilium " +
        "cannot edit a relation's target or isInheritable in place, so those changes delete and recreate " +
        'the attribute; the response then has replaced:true, oldAttributeId and the new attributeId.',
      setAttributeSchema,
      {
        title: 'Set attribute',
        readOnlyHint: false,
        destructiveHint: false,
        // Not idempotent: mode="add" creates a new attribute on every call.
        idempotentHint: false,
        openWorldHint: false,
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
        openWorldHint: false,
      }
    ),
  ];
}

export async function handleAttributeTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<ToolHandlerResult> {
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
      const own = ownAttributes(note.attributes, noteId);
      const labels = own.filter((a) => a.type === 'label');
      const relations = own.filter((a) => a.type === 'relation');

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
      const result = await setAttribute(client, parsed);
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

/** Attributes owned by the note itself (defensive: ETAPI returns owned ones). */
function ownAttributes(attributes: Attribute[], noteId: string): Attribute[] {
  return attributes.filter((a) => a.noteId === undefined || a.noteId === noteId);
}

type SetAttributeArgs = z.infer<typeof setAttributeSchema>;

/**
 * Create or upsert an attribute. ETAPI's PATCH /attributes only accepts value
 * and position for labels and only position for relations, so an upsert that
 * changes a relation's target or isInheritable has to delete and recreate.
 * The new attribute is created before the old one is deleted so a failure
 * never leaves the note without it.
 */
export async function setAttribute(
  client: TriliumClient,
  parsed: SetAttributeArgs
): Promise<Record<string, unknown>> {
  let existing: Attribute | undefined;
  if (!parsed.attributeId && parsed.mode !== 'add') {
    const note = await client.getNote(parsed.noteId);
    existing = ownAttributes(note.attributes, parsed.noteId).find(
      (a) => a.type === parsed.type && a.name === parsed.name
    );
  }

  if (!existing) {
    const created = await client.createAttribute({
      noteId: parsed.noteId,
      type: parsed.type as AttributeType,
      name: parsed.name,
      value: parsed.value,
      isInheritable: parsed.isInheritable,
      position: parsed.position,
      attributeId: parsed.attributeId,
    });
    return created as unknown as Record<string, unknown>;
  }

  const targetChanged = existing.type === 'relation' && existing.value !== parsed.value;
  const inheritableChanged =
    parsed.isInheritable !== undefined &&
    parsed.isInheritable !== (existing.isInheritable ?? false);

  if (targetChanged || inheritableChanged) {
    const created = await client.createAttribute({
      noteId: parsed.noteId,
      type: parsed.type as AttributeType,
      name: parsed.name,
      value: parsed.value,
      isInheritable: parsed.isInheritable ?? existing.isInheritable,
      position: parsed.position ?? existing.position,
    });
    try {
      await client.deleteAttribute(existing.attributeId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Created replacement attribute '${created.attributeId}' but failed to delete the old ` +
          `attribute '${existing.attributeId}' (${reason}). The note now has both; remove the old ` +
          `one with delete_attribute {attributeId:"${existing.attributeId}"}.`,
        { cause: error }
      );
    }
    return {
      ...(created as unknown as Record<string, unknown>),
      replaced: true,
      oldAttributeId: existing.attributeId,
      reason: targetChanged
        ? 'Relation targets cannot be edited in place; the attribute was recreated.'
        : 'isInheritable cannot be edited in place; the attribute was recreated.',
    };
  }

  if (existing.type === 'relation') {
    // Same target: only position can change.
    if (parsed.position === undefined) {
      return existing as unknown as Record<string, unknown>;
    }
    const updated = await client.updateAttribute(existing.attributeId, {
      position: parsed.position,
    });
    return updated as unknown as Record<string, unknown>;
  }

  const updated = await client.updateAttribute(existing.attributeId, {
    value: parsed.value,
    position: parsed.position,
  });
  return updated as unknown as Record<string, unknown>;
}
