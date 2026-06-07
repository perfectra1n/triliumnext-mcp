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
export const SERVER_INSTRUCTIONS = `This server manages a TriliumNext notes tree. Use search_notes and get_note_tree to explore before creating or moving notes, and confirm the parent with the user when unsure.

# Note types

Pick the right \`type\` (and \`mime\` where noted) when calling create_note. Most types need no extra setup; the "functional" types below are inert until you also wire attributes via set_attribute.

- text — rich-text note; \`content\` is HTML (or markdown with format="markdown"). The default for prose.
- code — source code or a runnable script. ALWAYS set \`mime\` (see below).
- render — an HTML "dashboard"/template view. \`mime\` is empty; must be wired with a renderNote relation (see below).
- mermaid — a Mermaid diagram; \`content\` is the diagram source.
- book — a container/folder that shows its children as a list or grid.
- canvas — an Excalidraw whiteboard; \`mime\` = "application/json".
- mindMap — a Mind-Elixir mind map; \`mime\` = "application/json".
- geoMap — a Leaflet geographic map; coordinates live in child-note labels.
- relationMap — a graphical map of notes and their relations.
- noteMap — an auto-generated link graph of a subtree.
- webView — embeds an external web page.

# Functional recipes (create the note, THEN wire attributes)

Creating these note types is only step 1 — they do nothing until you add the attributes below with set_attribute (name is given WITHOUT the leading # or ~).

## Runnable scripts (type="code")
- Frontend script (runs in the browser/UI): \`mime\` = "application/javascript;env=frontend".
- Backend script (runs on the server, full API access): \`mime\` = "application/javascript;env=backend".
- A script does not run on its own. To auto-run it, add a label \`run\`:
  set_attribute { type:"label", name:"run", value:"frontendStartup" }  (or "backendStartup", "hourly", "daily", …).
- A backend script can also be exposed as an HTTP endpoint with the label \`customRequestHandler\`.

## Render notes (type="render")
- A render note is blank until you point it at a code note that produces HTML.
- Create (or pick) a frontend code note that builds the markup, then:
  set_attribute { type:"relation", name:"renderNote", value:"<codeNoteId>" } on the render note.

## Custom widgets
- Create a frontend code note (mime "application/javascript;env=frontend") that returns a widget, then mark it:
  set_attribute { type:"label", name:"widget", value:"" }.

When you finish creating or wiring a note, give the user the returned \`url\` so they can open it directly.`;
