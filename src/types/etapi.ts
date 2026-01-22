/**
 * TypeScript types for TriliumNext ETAPI
 * Generated from etapi.openapi.yaml
 */

// Entity ID pattern: [a-zA-Z0-9_]{4,32}
export type EntityId = string;

// Date formats
export type LocalDateTime = string; // YYYY-MM-DD HH:mm:ss.SSS+ZZZZ
export type UtcDateTime = string; // YYYY-MM-DD HH:mm:ss.SSSZ

// Note types
export type NoteType =
  | 'text'
  | 'code'
  | 'render'
  | 'file'
  | 'image'
  | 'search'
  | 'relationMap'
  | 'book'
  | 'noteMap'
  | 'mermaid'
  | 'webView'
  | 'shortcut'
  | 'doc'
  | 'contentWidget'
  | 'launcher';

// Attribute types
export type AttributeType = 'label' | 'relation';

/**
 * Note entity returned from ETAPI
 */
export interface Note {
  noteId: EntityId;
  title: string;
  type: NoteType;
  mime: string;
  isProtected: boolean;
  blobId?: string;
  attributes: Attribute[];
  parentNoteIds: EntityId[];
  childNoteIds: EntityId[];
  parentBranchIds: EntityId[];
  childBranchIds: EntityId[];
  dateCreated: LocalDateTime;
  dateModified: LocalDateTime;
  utcDateCreated: UtcDateTime;
  utcDateModified: UtcDateTime;
}

/**
 * Request body for creating a note
 */
export interface CreateNoteDef {
  parentNoteId: EntityId;
  title: string;
  type: NoteType;
  content: string;
  mime?: string;
  notePosition?: number;
  prefix?: string;
  isExpanded?: boolean;
  noteId?: EntityId;
  branchId?: EntityId;
  dateCreated?: LocalDateTime;
  utcDateCreated?: UtcDateTime;
}

/**
 * Format for note export/revision
 */
export type ExportFormat = 'html' | 'markdown';

/**
 * Request body for patching a note
 */
export interface PatchNoteDef {
  title?: string;
  type?: NoteType;
  mime?: string;
  dateCreated?: LocalDateTime;
}

/**
 * Branch entity - places a note in the tree
 */
export interface Branch {
  branchId: EntityId;
  noteId: EntityId;
  parentNoteId: EntityId;
  prefix?: string;
  notePosition: number;
  isExpanded: boolean;
  utcDateModified: UtcDateTime;
}

/**
 * Request body for creating/updating a branch
 */
export interface CreateBranchDef {
  noteId: EntityId;
  parentNoteId: EntityId;
  prefix?: string;
  notePosition?: number;
  isExpanded?: boolean;
  branchId?: EntityId;
}

/**
 * Request body for patching a branch
 */
export interface PatchBranchDef {
  prefix?: string;
  notePosition?: number;
  isExpanded?: boolean;
}

/**
 * Response from create-note endpoint
 */
export interface NoteWithBranch {
  note: Note;
  branch: Branch;
}

/**
 * Attribute entity (label or relation)
 */
export interface Attribute {
  attributeId: EntityId;
  noteId: EntityId;
  type: AttributeType;
  name: string;
  value: string;
  position: number;
  isInheritable: boolean;
  utcDateModified: UtcDateTime;
}

/**
 * Request body for creating an attribute
 */
export interface CreateAttributeDef {
  noteId: EntityId;
  type: AttributeType;
  name: string;
  value: string;
  isInheritable?: boolean;
  position?: number;
  attributeId?: EntityId;
}

/**
 * Request body for patching an attribute
 */
export interface PatchAttributeDef {
  value?: string;
  position?: number;
}

/**
 * Attachment entity
 */
export interface Attachment {
  attachmentId: EntityId;
  ownerId: EntityId;
  role: string;
  mime: string;
  title: string;
  position: number;
  blobId?: string;
  dateModified: LocalDateTime;
  utcDateModified: UtcDateTime;
  utcDateScheduledForErasureSince?: UtcDateTime;
  contentLength: number;
}

/**
 * Request body for creating an attachment
 */
export interface CreateAttachmentDef {
  ownerId: EntityId;
  role: string;
  mime: string;
  title: string;
  content: string;
  position?: number;
}

/**
 * Request body for patching an attachment
 * Only role, mime, title, and position can be patched
 */
export interface PatchAttachmentDef {
  role?: string;
  mime?: string;
  title?: string;
  position?: number;
}

/**
 * Search response
 */
export interface SearchResponse {
  results: Note[];
  debugInfo?: Record<string, unknown>;
}

/**
 * Search parameters
 */
export interface SearchParams {
  search: string;
  fastSearch?: boolean;
  includeArchivedNotes?: boolean;
  ancestorNoteId?: EntityId;
  ancestorDepth?: string;
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
  limit?: number;
  debug?: boolean;
}

/**
 * App info response
 */
export interface AppInfo {
  appVersion: string;
  dbVersion: number;
  syncVersion: number;
  buildDate: string;
  buildRevision: string;
  dataDirectory: string;
  clipperProtocolVersion: string;
  utcDateTime: string;
}

/**
 * Error response
 */
export interface EtapiError {
  status: number;
  code: string;
  message: string;
}
