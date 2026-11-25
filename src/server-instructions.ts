/**
 * MCP "server instructions" — a server-level user manual injected once into the
 * client's system prompt (per the 2025-11-25 MCP spec, supported by the SDK's
 * Server `instructions` option). This is the canonical home for cross-tool
 * relationships and operational patterns that would otherwise bloat individual
 * tool descriptions (which reload on every tools/list call).
 *
 * Keep this factual, actionable, and concise — instruction compliance is
 * probabilistic and client-dependent, so the critical hints are also mirrored
 * as short pointers on the create_note/write_note `type`/`mime` fields.
 *
 * Note-type names and attribute values can vary slightly by TriliumNext
 * version; the values below were verified against a live instance.
 */
export const SERVER_INSTRUCTIONS = `This server manages a TriliumNext notes tree.

# Searching

search_notes defaults to strategy "auto": a plain-word query first matches titles and labels (fast) and searches note bodies only when that finds too few notes. A body search can take a long time on a large Trilium and blocks it meanwhile, so use strategy "full" only when the words may appear only inside note text. If a call fails with TRILIUM_BUSY, wait the suggested time instead of retrying at once.

# Working with notes

- Get note, branch and attribute IDs from search_notes, get_note_tree or get_note; never guess them.
- Explore with search_notes and get_note_tree before creating or moving notes, and confirm the parent with the user when unsure.
- Read content through these tools (get_note, get_attachment, get_revisions), not raw ETAPI/HTTP calls.
- write_note edits (changes/patch) match the stored HTML, not rendered text: read with get_note format="html" first and copy exact substrings.
- manage_system export returns a ZIP for the user to save; you cannot read its contents. Use get_note to read notes.
- Before rewriting a note wholesale, call create_revision (restore_revision also snapshots automatically) so the change can be undone.
- When a tool returns a \`url\`, give it to the user so they can open the note directly.

# Note types that need extra setup

Choose \`type\` (and \`mime\`) on create_note. These types do nothing until you also add attributes with set_attribute (name without the leading # or ~):

- code: set \`mime\`, e.g. "text/x-python". For scripts use "application/javascript;env=frontend" (runs in the UI) or "application/javascript;env=backend" (runs on the server). A script runs only when triggered: add label \`run\` = "frontendStartup", "backendStartup", "hourly", "daily", …; a backend script can serve HTTP via label \`customRequestHandler\`.
- render: \`mime\` empty. Create a frontend code note that builds the HTML, then add relation renderNote → that code note on the render note.
- Custom widget: a frontend code note that returns a widget, plus label \`widget\` with value "".
- canvas and mindMap: \`mime\` = "application/json". mermaid: \`content\` is the diagram source. geoMap: coordinates live in child-note labels.

# Linking notes

Link to another note with <a href="note:TARGET_NOTE_ID">text</a> (markdown: [text](note:TARGET_NOTE_ID)) in create_note/write_note content; the server builds the Trilium reference link. Use get_note include_path=true to tell the user where a note lives, and include_backlinks=true to find what links to it.`;
