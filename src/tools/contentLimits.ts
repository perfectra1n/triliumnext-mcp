/**
 * Guard rails for content returned to the LLM. A single oversized note,
 * revision, or attachment can blow out the model's context window, so text
 * bodies are capped by default with an explicit notice on how to continue.
 */

/** Default cap on text characters returned in one read (TRILIUM_CONTENT_CHAR_CAP). */
export const CONTENT_CHAR_CAP = 50_000;

let contentCharCap = CONTENT_CHAR_CAP;

/** Process-wide text cap. Called once at startup, before tools are registered. */
export function configureContentLimits(options: { contentCharCap?: number }): void {
  contentCharCap = options.contentCharCap ?? CONTENT_CHAR_CAP;
}

/** The configured text cap (defaults to {@link CONTENT_CHAR_CAP}). */
export function getContentCharCap(): number {
  return contentCharCap;
}

/** Human-readable size for tool descriptions and notices, e.g. "5 MB" or "1.5 MB". */
export function formatMegabytes(bytes: number): string {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

/** Byte length a base64 string decodes to, without decoding it. */
export function base64DecodedLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * Cap a text body at the configured character cap, appending a steering notice
 * describing what was cut and how to get the rest. Used for read paths without
 * paging parameters (revisions, attachments); get_note has its own
 * content_start/content_max_chars paging.
 */
export function capWithNotice(text: string, what: string, hint: string): string {
  const cap = contentCharCap;
  if (text.length <= cap) {
    return text;
  }
  return (
    text.slice(0, cap) +
    `\n\n---\n**Content truncated:** showing the first ${cap} of ${text.length} ` +
    `characters of this ${what}. ${hint}`
  );
}
