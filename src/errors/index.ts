import { ZodError, type ZodIssue } from 'zod';
import { TriliumClientError } from '../client/trilium.js';
import { DiffApplicationError } from '../tools/diff.js';
import { ContentNormalizationError } from '../tools/contentInput.js';

/**
 * Structured error information for MCP responses
 */
export interface StructuredError {
  message: string;
  status?: number;
  code?: string;
  suggestion?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Guidance map for common Trilium error codes
 */
const AUTH_GUIDANCE =
  'Authentication with Trilium failed (invalid or missing ETAPI token). This is a server configuration problem — do not retry; tell the user.';

const GENERIC_GUIDANCE = 'See the error message above.';

const TRILIUM_ERROR_GUIDANCE: Record<string, string> = {
  NOTE_NOT_FOUND:
    'The specified note ID does not exist. Use search_notes to find valid note IDs, or check for typos.',
  NOTE_IS_PROTECTED:
    'This note is protected. Choose a different note or unprotect it in Trilium first.',
  BRANCH_NOT_FOUND:
    'The specified branch ID does not exist. Get valid branch IDs from get_note (parentBranchIds/childBranchIds) or get_note_tree (childBranchIds / children[].branchId).',
  ATTRIBUTE_NOT_FOUND:
    'The specified attribute ID does not exist. Use get_attributes to list valid attribute IDs for a note.',
  ATTACHMENT_NOT_FOUND:
    'The specified attachment ID does not exist. Use get_attachment with a noteId to list attachments on that note.',
  ENTITY_NOT_FOUND: 'The specified entity does not exist. Verify the ID is correct.',
  INVALID_ENTITY_ID:
    'The entity ID format is invalid. Copy IDs exactly from search_notes, get_note_tree or get_note results.',
  NOTE_IS_DELETED:
    'This note has been deleted. Restore it with delete_note {action:"undelete", noteId} before using it, or pick another note.',
  VALIDATION_ERROR: 'The request contains invalid data. Check the field requirements.',
  PROPERTY_NOT_ALLOWED:
    'This Trilium version does not accept that field. utcDateModified on create_note/write_note needs a Trilium newer than 0.105 — drop the field or upgrade Trilium.',
  TRILIUM_UNREACHABLE:
    'The MCP server could not connect to Trilium (it already retried). Check that Trilium is running and that TRILIUM_URL points at its /etapi endpoint.',
  TRILIUM_TIMEOUT:
    'Trilium accepted the connection but did not answer in time, usually because a slow full-text search is holding its database. The operation may still complete server-side — re-read the note before retrying a write. For a short while, further calls to this Trilium fail fast with TRILIUM_BUSY.',
  TRILIUM_BUSY:
    'Trilium is still busy with an earlier slow request (usually a full-text search) and is not answering. Wait the time given in the message, then retry. Avoid strategy:"full" searches until it recovers: they would queue behind the slow one.',
  ETAPI_TOKEN_INVALID: AUTH_GUIDANCE,
};

/**
 * Guidance based on HTTP status codes when no specific error code is available
 */
const STATUS_CODE_GUIDANCE: Record<number, string> = {
  400: 'The request was malformed. Check the parameter values and formats.',
  401: AUTH_GUIDANCE,
  403: AUTH_GUIDANCE,
  404: 'The requested resource was not found. Verify the ID exists.',
  409: 'A conflict occurred. The resource may have been modified by another operation.',
  500: 'An internal server error occurred in Trilium. Try again or check Trilium logs.',
};

/**
 * Format a TriliumClientError into a structured error with actionable guidance
 */
export function formatTriliumError(error: TriliumClientError): StructuredError {
  const suggestion =
    TRILIUM_ERROR_GUIDANCE[error.code] ?? STATUS_CODE_GUIDANCE[error.status] ?? GENERIC_GUIDANCE;

  return {
    message: error.message,
    status: error.status,
    code: error.code,
    suggestion,
  };
}

/**
 * Format a single Zod issue into a human-readable message
 */
function formatZodIssue(issue: ZodIssue): string {
  const path = issue.path.join('.');
  const fieldName = path || 'input';

  // Zod 4 uses different issue codes
  switch (issue.code) {
    case 'invalid_type': {
      const typeIssue = issue as { expected?: string; message: string };
      // Check if it's a missing field (received undefined) by looking at the message
      if (typeIssue.message.includes('received undefined')) {
        return `${fieldName}: Required field is missing`;
      }
      // Return the full message which includes expected/received info
      if (typeIssue.expected) {
        return `${fieldName}: ${typeIssue.message}`;
      }
      return `${fieldName}: Invalid type`;
    }

    case 'invalid_value': {
      // This is used for enum validation in Zod 4
      const valueIssue = issue as { values?: unknown[]; message: string };
      if (valueIssue.values) {
        return `${fieldName}: Invalid value. Allowed values: ${valueIssue.values.join(', ')}`;
      }
      return `${fieldName}: ${valueIssue.message}`;
    }

    // Zod 4 messages for these already name the bound and type ("Too small: expected
    // string to have >=1 characters"), and validators supply custom messages (e.g.
    // the entity-ID regex hint) that must reach the model verbatim.
    case 'too_small':
    case 'too_big':
    case 'invalid_format':
      return `${fieldName}: ${issue.message}`;

    case 'custom': {
      const customIssue = issue as { message: string };
      return `${fieldName}: ${customIssue.message}`;
    }

    default:
      return `${fieldName}: ${issue.message}`;
  }
}

/**
 * Format a ZodError into a structured error with field-specific messages
 */
export function formatZodError(error: ZodError, toolName?: string): StructuredError {
  const fieldErrors: Record<string, string> = {};

  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'input';
    const formatted = formatZodIssue(issue);
    // Several issues can share a path (e.g. min length and regex); keep all of them.
    fieldErrors[path] =
      fieldErrors[path] === undefined
        ? formatted
        : `${fieldErrors[path]}; ${formatted.slice(path.length + 2)}`;
  }

  const errorList = Object.values(fieldErrors)
    .map((e) => `  - ${e}`)
    .join('\n');
  const suggestion = `Check the following fields and correct them:\n${errorList}`;

  return {
    message: toolName ? `Invalid input for tool "${toolName}"` : 'Invalid input',
    suggestion,
    fieldErrors,
  };
}

/**
 * Format a DiffApplicationError into a structured error with actionable guidance
 */
export function formatDiffError(error: DiffApplicationError): StructuredError {
  return {
    message: error.message,
    code: 'DIFF_APPLICATION_FAILED',
    suggestion: diffSuggestion(error.message),
  };
}

function diffSuggestion(message: string): string {
  if (message.includes('ambiguous')) {
    return 'old_string matches more than once. Add surrounding context so old_string is unique.';
  }
  if (message.includes('could not find')) {
    return (
      'old_string was not found. Edits match the stored HTML, not rendered text: re-read with ' +
      'get_note format="html" and copy the exact substring.'
    );
  }
  if (message.includes('read-back verification')) {
    return 'Trilium normalized the saved HTML. Re-read with get_note format="html" before editing again.';
  }
  return 'Re-read the note with get_note format="html" and retry with changes based on the current content.';
}

/**
 * Format a ContentNormalizationError (file path / URL / base64 content input
 * resolution failure) into a structured error with actionable guidance.
 */
export function formatContentInputError(error: ContentNormalizationError): StructuredError {
  return {
    message: error.message,
    code: error.code,
    suggestion: error.suggestion,
  };
}

/**
 * Format an unknown error into a structured error
 */
export function formatUnknownError(error: unknown): StructuredError {
  const message = error instanceof Error ? error.message : String(error);

  return {
    message,
    suggestion: GENERIC_GUIDANCE,
  };
}

/**
 * Format a structured error into an MCP-compatible response
 */
export function formatErrorForMCP(structured: StructuredError): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  const parts: string[] = [];

  parts.push(`**Error**: ${structured.message}`);

  if (structured.status !== undefined && structured.code) {
    parts.push(`**Status**: ${structured.status} (${structured.code})`);
  } else if (structured.status !== undefined) {
    parts.push(`**Status**: ${structured.status}`);
  } else if (structured.code) {
    parts.push(`**Code**: ${structured.code}`);
  }

  if (structured.suggestion) {
    parts.push('');
    parts.push(`**Suggestion**: ${structured.suggestion}`);
  }

  return {
    content: [{ type: 'text', text: parts.join('\n') }],
    isError: true,
  };
}
