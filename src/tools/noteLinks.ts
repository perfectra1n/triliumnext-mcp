import type { TriliumClient } from '../client/trilium.js';

/**
 * `note:<noteId>` link placeholders.
 *
 * A true Trilium note-to-note link needs `class="reference-link"`, an
 * `href="#root/<path>"` AND a matching `data-note-path` — and the path has to
 * be walked up from the target note. Models get this wrong constantly, and a
 * wrong link is silently stored as an inert anchor. Instead, callers write
 * `<a href="note:abc123">` (or markdown `[text](note:abc123)`) and the server
 * builds the real link, failing loudly if the target does not exist.
 */
const NOTE_LINK_SOURCE = /<a\b[^>]*?\shref=(["'])note:([A-Za-z0-9_]{4,32})\1[^>]*>([\s\S]*?)<\/a>/
  .source;

// Fresh RegExp per use: a shared /g regex carries lastIndex between calls, and
// matchAll copies it — a prior .test() would make the next scan start mid-string.
const noteLinkPattern = (): RegExp => new RegExp(NOTE_LINK_SOURCE, 'g');

/** Cheap pre-check so callers can skip work (and network calls) when no placeholder is present. */
export function hasNoteLinkPlaceholders(html: string): boolean {
  return new RegExp(NOTE_LINK_SOURCE).test(html);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Replace every `note:<id>` anchor with a Trilium reference link. An empty link
 * text is filled with the target's title. Unknown note IDs reject with the
 * client's NOTE_NOT_FOUND error — the write never happens with a broken link.
 */
export async function resolveNoteLinks(client: TriliumClient, html: string): Promise<string> {
  if (!hasNoteLinkPlaceholders(html)) return html;

  const ids = new Set<string>();
  for (const match of html.matchAll(noteLinkPattern())) ids.add(match[2]);

  const targets = new Map<string, { path: string; title: string }>();
  await Promise.all(
    [...ids].map(async (id) => {
      const note = await client.getNote(id);
      const path = await client.getNotePath(id);
      targets.set(id, { path, title: note.title });
    })
  );

  return html.replace(noteLinkPattern(), (whole, _quote: string, id: string, text: string) => {
    const target = targets.get(id);
    if (!target) return whole;
    const label = text.trim() === '' ? escapeHtml(target.title) : text;
    return (
      `<a class="reference-link" href="#${target.path}" data-note-path="${target.path}">` +
      `${label}</a>`
    );
  });
}

/**
 * Trilium only scans a note's content for links (internalLink / imageLink
 * relations that power backlinks and the note map) when the content is saved
 * through PUT /notes/{id}/content — POST /create-note skips it. A text note
 * created with links therefore needs one extra content write to be indexed.
 */
export function needsLinkIndexing(html: string): boolean {
  return /href=["']#root\//.test(html) || /src=["'][^"']*api\/(attachments|images)\//.test(html);
}
