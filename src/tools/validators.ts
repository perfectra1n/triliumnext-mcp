import { z } from 'zod';

/**
 * Valid note types in Trilium
 */
export const NOTE_TYPES = [
  'text',
  'code',
  'file',
  'image',
  'search',
  'book',
  'relationMap',
  'render',
] as const;

/**
 * Valid attribute types in Trilium
 */
export const ATTRIBUTE_TYPES = ['label', 'relation'] as const;

/**
 * Valid export formats
 */
export const EXPORT_FORMATS = ['html', 'markdown'] as const;

/**
 * Valid order directions
 */
export const ORDER_DIRECTIONS = ['asc', 'desc'] as const;

/**
 * Entity ID validator (4-32 alphanumeric characters)
 * Used for noteId, branchId, attributeId
 */
export const entityIdSchema = z
  .string()
  .min(1, 'ID is required')
  .refine(
    (val) => val === 'root' || /^[a-zA-Z0-9]{4,32}$/.test(val),
    'ID must be 4-32 alphanumeric characters (or "root" for the root note)'
  );

/**
 * Optional entity ID validator for forced IDs in create operations
 */
export const optionalEntityIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9]{4,32}$/, 'ID must be 4-32 alphanumeric characters')
  .optional();

/**
 * Note type validator
 */
export const noteTypeSchema = z.enum(NOTE_TYPES, {
  message: `Invalid note type. Allowed values: ${NOTE_TYPES.join(', ')}`,
});

/**
 * Attribute type validator
 */
export const attributeTypeSchema = z.enum(ATTRIBUTE_TYPES, {
  message: `Invalid attribute type. Allowed values: ${ATTRIBUTE_TYPES.join(', ')}`,
});

/**
 * Export format validator
 */
export const exportFormatSchema = z.enum(EXPORT_FORMATS, {
  message: `Invalid export format. Allowed values: ${EXPORT_FORMATS.join(', ')}`,
});

/**
 * Order direction validator
 */
export const orderDirectionSchema = z.enum(ORDER_DIRECTIONS, {
  message: `Invalid order direction. Allowed values: ${ORDER_DIRECTIONS.join(', ')}`,
});

/**
 * Local datetime validator
 * Format: "YYYY-MM-DD HH:mm:ss.SSS+ZZZZ" (e.g., "2024-01-15 10:30:00.000+0100")
 */
export const localDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/,
    'Invalid datetime format. Expected: "YYYY-MM-DD HH:mm:ss.SSS+ZZZZ" (e.g., "2024-01-15 10:30:00.000+0100")'
  );

/**
 * UTC datetime validator
 * Format: "YYYY-MM-DD HH:mm:ss.SSSZ" (e.g., "2024-01-15 09:30:00.000Z")
 */
export const utcDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    'Invalid UTC datetime format. Expected: "YYYY-MM-DD HH:mm:ss.SSSZ" (e.g., "2024-01-15 09:30:00.000Z")'
  );

/**
 * Date validator for calendar operations
 * Format: "YYYY-MM-DD"
 */
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format. Expected: "YYYY-MM-DD" (e.g., "2024-01-15")');

/**
 * Week validator for calendar operations
 * Format: "YYYY-Www" (e.g., "2024-W03")
 */
export const weekSchema = z
  .string()
  .regex(/^\d{4}-W\d{2}$/, 'Invalid week format. Expected: "YYYY-Www" (e.g., "2024-W03")');

/**
 * Month validator for calendar operations
 * Format: "YYYY-MM"
 */
export const monthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Invalid month format. Expected: "YYYY-MM" (e.g., "2024-01")');

/**
 * Year validator for calendar operations
 * Format: "YYYY"
 */
export const yearSchema = z
  .string()
  .regex(/^\d{4}$/, 'Invalid year format. Expected: "YYYY" (e.g., "2024")');

/**
 * Position validator (positive integer for ordering)
 */
export const positionSchema = z
  .number()
  .int('Position must be an integer')
  .positive('Position must be positive');

/**
 * Search limit validator
 */
export const searchLimitSchema = z
  .number()
  .int('Limit must be an integer')
  .min(1, 'Limit must be at least 1')
  .max(10000, 'Limit cannot exceed 10000');

/**
 * Non-empty string validator
 */
export const nonEmptyStringSchema = z.string().min(1, 'Value cannot be empty');

/**
 * Backup name validator (alphanumeric and hyphens/underscores)
 */
export const backupNameSchema = z
  .string()
  .min(1, 'Backup name is required')
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'Backup name must contain only alphanumeric characters, hyphens, and underscores'
  );
