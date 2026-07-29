import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { TriliumClientError } from '../client/trilium.js';
import { defineTool } from './schemas.js';
import { orderDirectionSchema, searchLimitSchema } from './validators.js';
import { preprocessSearchQuery } from './queryPreprocessor.js';

const searchNotesSchema = z.object({
  query: z
    .string()
    .min(1, 'Search query is required')
    .describe(
      'Trilium search query. Fulltext: "word1 word2" (implicit AND), "exact phrase" (quotes). ' +
        'Labels: #label, #label=value, #!label (negation). Relations: ~relation. ' +
        'Operators: = != *=* =* *= >= > < <=. ' +
        'Boolean: "term1 or term2" for OR between any terms, AND with parentheses. ' +
        'Examples: "meeting", "#project", "#status = active", "meeting #project"'
    ),
  fastSearch: z.boolean().optional().describe('Enable fast search (skips content search)'),
  includeArchivedNotes: z.boolean().optional().describe('Include archived notes'),
  ancestorNoteId: z.string().optional().describe('Search only in subtree of this note'),
  ancestorDepth: z
    .string()
    .regex(
      /^(eq|lt|gt)\d{1,3}$/,
      'Invalid ancestorDepth. Expected eqN, ltN, or gtN (e.g. "eq1", "lt3")'
    )
    .optional()
    .describe(
      'Depth constraint relative to ancestorNoteId: "eq1" = direct children only, ' +
        '"lt3" = fewer than 3 levels deep, "gt1" = deeper than direct children.'
    ),
  orderBy: z
    .string()
    .optional()
    .describe(
      'Property to order by: title, dateCreated, dateModified, utcDateCreated, utcDateModified, ' +
        'isProtected, isArchived, or a label (e.g. "#publicationDate").'
    ),
  orderDirection: orderDirectionSchema.optional().describe('Order direction'),
  limit: searchLimitSchema
    .optional()
    .describe('Maximum number of results. No default — pass one to bound large result sets.'),
  debug: z
    .boolean()
    .optional()
    .describe('Return query-parse diagnostics from Trilium (for troubleshooting search syntax).'),
});

const fuzzySearchSchema = z.object({
  query: z
    .string()
    .min(1, 'Search query is required')
    .describe(
      'Fuzzy search: type whatever you remember — keywords, partial titles, tags, or descriptions. ' +
        'All terms are matched independently (OR logic). Results are ranked by relevance. ' +
        'Examples: "体积云 Niagara", "UE5 粒子 教程", "trilium backup tool"'
    ),
  limit: searchLimitSchema.optional().default(20).describe('Maximum number of results (default 20)'),
  threshold: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(1)
    .describe('Minimum number of query terms a note must match to be included (default 1)'),
  ancestorNoteId: z.string().optional().describe('Search only in subtree of this note'),
  includeArchivedNotes: z.boolean().optional().describe('Include archived notes'),
});

const getNoteTreeSchema = z.object({
  noteId: z
    .string()
    .min(1, 'Note ID is required')
    .describe('ID of the parent note (use "root" for the root note)'),
  depth: z
    .number()
    .int('Depth must be an integer')
    .min(1, 'Depth must be at least 1')
    .max(5, 'Depth cannot exceed 5')
    .default(1)
    .describe(
      'How many levels of children to expand (default 1, max 5). Expanded nodes include title/type; ' +
        'nodes at the boundary include childNoteIds for further drilling.'
    ),
});

/** Soft cap on notes fetched per get_note_tree call to bound response size. */
const MAX_TREE_NOTES = 200;

type NoteLike = Awaited<ReturnType<TriliumClient['getNote']>>;

interface TreeNode {
  noteId: string;
  title?: string;
  type?: string;
  childCount?: number;
  childBranchIds?: string[];
  systemChildrenSkipped?: number;
  childNoteIds?: string[];
  children?: TreeNode[];
  error?: string;
}

async function buildTree(
  client: TriliumClient,
  note: NoteLike,
  depth: number,
  includeSystem: boolean,
  budget: { remaining: number; truncated: boolean }
): Promise<TreeNode> {
  const allChildIds = note.childNoteIds ?? [];
  const visibleIds = includeSystem ? allChildIds : allChildIds.filter((id) => !id.startsWith('_'));

  const node: TreeNode = {
    noteId: note.noteId,
    title: note.title,
    type: note.type,
    childCount: visibleIds.length,
    childBranchIds: note.childBranchIds,
  };
  const skipped = allChildIds.length - visibleIds.length;
  if (skipped > 0) {
    node.systemChildrenSkipped = skipped;
  }

  if (depth <= 0 || visibleIds.length === 0) {
    if (visibleIds.length > 0) {
      node.childNoteIds = visibleIds;
    }
    return node;
  }

  const toFetch = visibleIds.slice(0, Math.max(0, budget.remaining));
  if (toFetch.length < visibleIds.length) {
    budget.truncated = true;
  }
  budget.remaining -= toFetch.length;

  node.children = await Promise.all(
    toFetch.map(async (id): Promise<TreeNode> => {
      try {
        const child = await client.getNote(id);
        return await buildTree(client, child, depth - 1, includeSystem, budget);
      } catch (error) {
        return { noteId: id, error: error instanceof Error ? error.message : String(error) };
      }
    })
  );
  return node;
}

export function registerSearchTools(): Tool[] {
  return [
    defineTool(
      'search_notes',
      `Search notes using full-text search and/or attribute filters. Supports Trilium search syntax. Use this tool to find existing notes, discover the note hierarchy, and identify the best parent before creating or moving notes.

**Full-text search:**
- \`rings tolkien\` - Both terms must appear (implicit AND between words)
- \`"exact phrase"\` - Use quotes for exact phrase matching

**Attribute filters (labels and relations):**
- \`#labelname\` - Notes with label
- \`#!labelname\` - Notes WITHOUT label
- \`#year = 1954\` - Label with exact value
- \`#year >= 1950\` - Numeric comparison (>=, >, <, <=)
- \`#name *=* john\` - Label value contains "john"
- \`~relationname\` - Notes with relation

**Combining searches:**
- \`tolkien #book\` - Fulltext AND attribute (space = implicit AND)
- \`meeting or project\` - OR between fulltext terms
- \`#book or #article\` - OR between attributes
- \`(#year >= 1950 AND #year <= 1960)\` - AND with parentheses for grouping

**Direct note lookup:**
- \`id:abc123\` - Look up a note directly by its ID (any 4-32 char ID, including digit-free ones)
- Single 12-character alphanumeric tokens containing a digit are auto-detected as note IDs (e.g., \`abc123def456\`); if no note has that ID, the query falls back to a normal search

**Title search:**
- \`title:meeting\` - Search notes by title containing "meeting"
- \`title:meeting notes\` - Title containing "meeting notes" (auto-quoted)
- \`title:"exact title"\` - Title containing exact phrase
- \`title:meeting or title:project\` - Title OR search

**String operators:** = (exact), != (not equal), *=* (contains), =* (starts with), *= (ends with), %= (regex)

**Note properties:** note.title, note.dateCreated, note.dateModified, note.parents.title, note.ancestors.title

**Examples:**
- \`meeting\` - Notes containing "meeting"
- \`#project\` - Notes with "project" label
- \`#status = active\` - Notes where status label equals "active"
- \`meeting #project\` - Notes containing "meeting" with "project" label
- \`#type = task #priority = high\` - Multiple label conditions (implicit AND)
- \`meeting or project\` - Notes containing "meeting" OR "project"
- \`id:abc123def\` - Direct lookup of note by ID
- \`title:weekly meeting\` - Notes with "weekly meeting" in title

**Results:** returns \`{results: [...]}\` with note metadata only (noteId, title, type, dates, attributes) — content bodies are NOT included; call get_note for the body. There is no default limit, so pass \`limit\` to bound large result sets. To scope a search to a subtree, combine \`ancestorNoteId\` with \`ancestorDepth\` (e.g. \`eq1\` = direct children only).`,
      searchNotesSchema,
      { title: 'Search notes', readOnlyHint: true, openWorldHint: false }
    ),
    defineTool(
      'get_note_tree',
      'Explore the note hierarchy. Returns the note with its children expanded "depth" levels (default 1) — ' +
        'each expanded node includes noteId, title, type, childCount, and childBranchIds (branch IDs are what ' +
        'organize_note reorder/unlink need). Nodes at the depth boundary include childNoteIds so you can drill ' +
        'further with another call. System notes (IDs starting with "_", e.g. the _hidden subtree under root) are ' +
        'skipped unless you request a system note directly. At most ~200 notes are fetched per call; the response ' +
        'is marked truncated when the cap is hit. ' +
        'Use this tool to explore the hierarchy before creating or moving notes — start from "root" to see top-level structure. ' +
        'When the user asks to create or organize notes, proactively explore the tree and suggest where the note should go.',
      getNoteTreeSchema,
      { title: 'Get note tree', readOnlyHint: true }
    ),
    defineTool(
      'fuzzy_search_notes',
      'Fuzzy search: type whatever you remember and find notes that match any of your keywords. ' +
        'Results are ranked by relevance — notes matching more keywords in their title rank highest. ' +
        'Unlike search_notes which requires exact AND matches, this uses OR logic so partial recall works.',
      fuzzySearchSchema,
      { title: 'Fuzzy search notes', readOnlyHint: true }
    ),
  ];
}

export async function handleSearchTool(
  client: TriliumClient,
  name: string,
  args: unknown
): Promise<{ content: Array<{ type: 'text'; text: string }> } | null> {
  switch (name) {
    case 'search_notes': {
      const parsed = searchNotesSchema.parse(args);
      const preprocessed = preprocessSearchQuery(parsed.query);

      if (preprocessed.type === 'noteIdLookup') {
        try {
          const note = await client.getNote(preprocessed.query);
          const result = { results: [note] };
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          if (error instanceof TriliumClientError && error.status === 404) {
            // Note not found — fall back to regular search
            const result = await client.searchNotes({
              search: preprocessed.query,
              fastSearch: parsed.fastSearch,
              includeArchivedNotes: parsed.includeArchivedNotes,
              ancestorNoteId: parsed.ancestorNoteId,
              ancestorDepth: parsed.ancestorDepth,
              orderBy: parsed.orderBy,
              orderDirection: parsed.orderDirection,
              limit: parsed.limit,
              debug: parsed.debug,
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };
          }
          throw error;
        }
      }

      const result = await client.searchNotes({
        search: preprocessed.query,
        fastSearch: parsed.fastSearch,
        includeArchivedNotes: parsed.includeArchivedNotes,
        ancestorNoteId: parsed.ancestorNoteId,
        ancestorDepth: parsed.ancestorDepth,
        orderBy: parsed.orderBy,
        orderDirection: parsed.orderDirection,
        limit: parsed.limit,
        debug: parsed.debug,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    case 'get_note_tree': {
      const parsed = getNoteTreeSchema.parse(args);
      const includeSystem = parsed.noteId.startsWith('_');
      const budget = { remaining: MAX_TREE_NOTES, truncated: false };
      const root = await client.getNote(parsed.noteId);
      const tree = await buildTree(client, root, parsed.depth, includeSystem, budget);
      const payload: Record<string, unknown> = { ...tree };
      if (budget.truncated) {
        payload.truncated = true;
        payload.note =
          `Fetched at most ${MAX_TREE_NOTES} notes; some children are omitted. ` +
          'Call get_note_tree on a child noteId to continue exploring.';
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    }

    case 'fuzzy_search_notes': {
      const parsed = fuzzySearchSchema.parse(args);

      // 1. Tokenize: split by whitespace and common punctuation
      const rawTerms = parsed.query
        .split(/[\s,，、;；。.．!！?？()（）\[\]【】{}「」『』:：]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2);

      // Remove duplicates and lowercase
      const uniqueTerms = [...new Set(rawTerms.map((t) => t.toLowerCase()))];

      if (uniqueTerms.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
        };
      }

      // 2. Build OR query
      const orQuery = uniqueTerms
        .map((t) => {
          // Quote terms with special chars to prevent Trilium parsing issues
          if (/[^a-zA-Z0-9\u4e00-\u9fff_-]/.test(t)) return `"${t}"`;
          return t;
        })
        .join(' or ');

      // 3. Preprocess (converts bare fulltext OR to note.content *=* form)
      const preprocessed = preprocessSearchQuery(orQuery);

      // 4. Search with high recall
      const searchResult = await client.searchNotes({
        search: preprocessed.query,
        includeArchivedNotes: parsed.includeArchivedNotes,
        ancestorNoteId: parsed.ancestorNoteId,
        limit: 200,
      });

      // 5. Client-side scoring
      type ScoredNote = { note: (typeof searchResult.results)[0]; score: number; matchedTerms: number };
      const scored: ScoredNote[] = searchResult.results.map((note) => {
        const lowerTitle = note.title.toLowerCase();
        let score = 0;
        let matchedTerms = 0;

        for (const term of uniqueTerms) {
          // Check title
          if (lowerTitle.includes(term)) {
            score += 10;
            matchedTerms++;
            // Bonus for exact word match in title
            const titleWords = lowerTitle.split(/[\s,，、；：()（）\[\]【】/\\_\-]+/);
            if (titleWords.some((w) => w === term)) {
              score += 5;
            }
          }
          // Check tag values
          for (const attr of note.attributes) {
            if (attr.type === 'label' && attr.name === 'tag' && attr.value.toLowerCase().includes(term)) {
              score += 3;
              break;
            }
          }
        }

        return { note, score, matchedTerms };
      });

      // 6. Filter by threshold and sort
      const threshold = parsed.threshold ?? 1;
      const maxResults = parsed.limit ?? 20;
      const filtered = scored
        .filter((s) => s.matchedTerms >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map((s) => ({ ...s.note, _score: s.score, _matchedTerms: s.matchedTerms }));

      return {
        content: [{ type: 'text', text: JSON.stringify({ results: filtered }, null, 2) }],
      };
    }

    default:
      return null;
  }
}
