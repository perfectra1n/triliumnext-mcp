import { ZodError, type ZodIssue } from 'zod';
import { TriliumClientError } from '../client/trilium.js';

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
const TRILIUM_ERROR_GUIDANCE: Record<string, string> = {
  NOTE_NOT_FOUND:
    'The specified note ID does not exist. Use search_notes to find valid note IDs, or check for typos.',
  NOTE_IS_PROTECTED:
    'This note is protected. Choose a different note or unprotect it in Trilium first.',
  BRANCH_NOT_FOUND:
    "The specified branch ID does not exist. Use get_note to retrieve valid branch IDs from a note's parentBranch or childBranches.",
  ATTRIBUTE_NOT_FOUND:
    'The specified attribute ID does not exist. Use get_attributes to list valid attribute IDs for a note.',
  ATTACHMENT_NOT_FOUND:
    'The specified attachment ID does not exist. Use get_note to find attachments associated with a note.',
  ENTITY_NOT_FOUND: 'The specified entity does not exist. Verify the ID is correct.',
  INVALID_ENTITY_ID: 'The entity ID format is invalid. IDs must be 4-32 alphanumeric characters.',
  NOTE_IS_DELETED: 'This note has been deleted. It cannot be accessed or modified.',
  VALIDATION_ERROR: 'The request contains invalid data. Check the field requirements.',
  ETAPI_TOKEN_INVALID:
    'The API token is invalid or expired. Check your TRILIUM_TOKEN configuration.',
};

/**
 * Guidance based on HTTP status codes when no specific error code is available
 */
const STATUS_CODE_GUIDANCE: Record<number, string> = {
  400: 'The request was malformed. Check the parameter values and formats.',
  401: 'Authentication failed. Verify your TRILIUM_TOKEN is correct.',
  403: 'Access denied. The token may lack required permissions.',
  404: 'The requested resource was not found. Verify the ID exists.',
  409: 'A conflict occurred. The resource may have been modified by another operation.',
  500: 'An internal server error occurred in Trilium. Try again or check Trilium logs.',
};

/**
 * Format a TriliumClientError into a structured error with actionable guidance
 */
export function formatTriliumError(error: TriliumClientError): StructuredError {
  const suggestion =
    TRILIUM_ERROR_GUIDANCE[error.code] ??
    STATUS_CODE_GUIDANCE[error.status] ??
    'An unexpected error occurred. Check the error details for more information.';

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

    case 'too_small': {
      const smallIssue = issue as { minimum?: number; message: string };
      if (smallIssue.minimum !== undefined) {
        return `${fieldName}: Must be at least ${smallIssue.minimum} characters`;
      }
      return `${fieldName}: ${smallIssue.message}`;
    }

    case 'too_big': {
      const bigIssue = issue as { maximum?: number; message: string };
      if (bigIssue.maximum !== undefined) {
        return `${fieldName}: Must be at most ${bigIssue.maximum} characters`;
      }
      return `${fieldName}: ${bigIssue.message}`;
    }

    case 'invalid_format':
      return `${fieldName}: Invalid format`;

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
    fieldErrors[path] = formatZodIssue(issue);
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
 * Format an unknown error into a structured error
 */
export function formatUnknownError(error: unknown): StructuredError {
  const message = error instanceof Error ? error.message : String(error);

  return {
    message,
    suggestion: 'An unexpected error occurred. Check the error message for details.',
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
