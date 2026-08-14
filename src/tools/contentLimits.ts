/**
 * Guard rails for content returned to the LLM. A single oversized note,
 * revision, or attachment can blow out the model's context window, so text
 * bodies are capped by default with an explicit notice on how to continue.
 */
export const CONTENT_CHAR_CAP = 50_000;

/**
 * Cap a text body at CONTENT_CHAR_CAP characters, appending a steering notice
 * describing what was cut and how to get the rest. Used for read paths without
 * paging parameters (revisions, attachments); get_note has its own
 * content_start/content_max_chars paging.
 */
export function capWithNotice(text: string, what: string, hint: string): string {
  if (text.length <= CONTENT_CHAR_CAP) {
    return text;
  }
  return (
    text.slice(0, CONTENT_CHAR_CAP) +
    `\n\n---\n**Content truncated:** showing the first ${CONTENT_CHAR_CAP} of ${text.length} ` +
    `characters of this ${what}. ${hint}`
  );
}
