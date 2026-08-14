import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TriliumClient } from '../client/trilium.js';
import { TriliumClientError } from '../client/trilium.js';
import { defineTool } from './schemas.js';
import { orderDirectionSchema, searchLimitSchema } from './validators.js';
import { preprocessSearchQuery } from './queryPreprocessor.js';
import {
  buildFuzzyQuery,
  extractFuzzyTerms,
  isFuzzyEligible,
  rankNotes,
  resolveFuzzyLimit,
  type FuzzyMode,
} from './fuzzySearch.js';

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
  fuzzy: z
    .enum(['auto', 'off', 'force'])
    .optional()
    .default('auto')
    .describe(
      'Fallback behavior when the query finds nothing. "auto" (default): if the exact query returns ZERO ' +
        'results and the query is plain fulltext with 2+ terms, retry it as an OR over the individual terms, ' +
        'ranked by title/attribute relevance — the response then carries searchMode:"fuzzy" and fuzzyTerms. ' +
        '"off": never retry; exact Trilium semantics only. "force": go straight to the ranked OR search. ' +
        'Never applies to attribute (#label), property (note.*), id:/title:-prefixed, or already-OR queries.'
    ),
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

**Results:** returns \`{results: [...]}\` with note metadata only (noteId, title, type, dates, attributes) — content bodies are NOT included; call get_note for the body. There is no default limit, so pass \`limit\` to bound large result sets. To scope a search to a subtree, combine \`ancestorNoteId\` with \`ancestorDepth\` (e.g. \`eq1\` = direct children only).

**Graceful fallback (\`fuzzy\`):**
Trilium ANDs fulltext terms, so one wrong term returns nothing. By default (\`fuzzy: "auto"\`),
a plain-fulltext query with 2+ terms that returns ZERO results is automatically retried as an
OR over the individual terms, ranked by relevance. The response then adds \`searchMode: "fuzzy"\`,
\`fuzzyTerms\`, \`totalCandidates\`, and \`termsMatchedInTitleOrAttributes\` — use that last one to
spot which term is failing and re-query without it. Ranking uses titles and attributes only, so
a note matching only in its body is still returned but ranks low: scan past the first result.
Set \`fuzzy: "off"\` for strict Trilium semantics, or \`"force"\` to skip the exact attempt.
Never applies to \`#label\`, \`note.*\`, \`id:\`/\`title:\`, or already-OR queries.`,
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
  ];
}

type SearchArgs = z.infer<typeof searchNotesSchema>;

/** Scope and shaping options shared by the exact search and its fuzzy retry. */
function scopeParams(parsed: SearchArgs) {
  return {
    fastSearch: parsed.fastSearch,
    includeArchivedNotes: parsed.includeArchivedNotes,
    ancestorNoteId: parsed.ancestorNoteId,
    ancestorDepth: parsed.ancestorDepth,
    orderBy: parsed.orderBy,
    orderDirection: parsed.orderDirection,
    debug: parsed.debug,
  };
}

/**
 * Explain the rewrite to the caller. This is not decoration: the model needs to know
 * the results are approximate, that relevance is title-only so the right note may not
 * be first, and what a zero in the per-term counts actually means.
 */
function describeFuzzyRun(args: {
  terms: string[];
  returned: number;
  totalCandidates: number;
  reranked: boolean;
  forced: boolean;
}): string {
  const { terms, returned, totalCandidates, reranked, forced } = args;
  const termList = `${terms.length} term(s): ${terms.join(', ')}`;
  return [
    // Under fuzzy="force" no exact search was ever run, so claiming one failed
    // would be a lie the caller has no way to check.
    forced
      ? `Ran directly as an OR search over ${termList}, as requested by fuzzy="force".`
      : `No notes matched all terms. Retried as an OR search over ${termList}.`,
    reranked
      ? 'Results are ranked by title and attribute relevance.'
      : 'Results keep the ordering you requested via orderBy rather than being re-ranked by relevance.',
    `Showing ${returned} of ${totalCandidates} candidates.`,
    'Relevance is computed from titles and attributes only — Trilium\'s search response carries no note ' +
      'content — so a note matching only in its body still appears, ranked low. Scan past the first result.',
    'In termsMatchedInTitleOrAttributes, a 0 means the term was absent from these results\' titles and ' +
      'attributes, not that it is absent from the notes.',
    'Pass fuzzy="off" to disable this fallback.',
  ].join(' ');
}

async function runFuzzySearch(
  client: TriliumClient,
  parsed: SearchArgs,
  terms: string[],
  forced: boolean
): Promise<Record<string, unknown>> {
  const { fetchLimit, sliceTo } = resolveFuzzyLimit(parsed.limit);
  const response = await client.searchNotes({
    ...scopeParams(parsed),
    search: buildFuzzyQuery(terms),
    limit: fetchLimit,
  });

  const ranked = rankNotes(response.results, terms);
  // An explicit orderBy is an instruction, not a preference — honor it and take only
  // the recall win. Ranking is still computed, for the per-term evidence counts.
  const reranked = !parsed.orderBy;
  const ordered = reranked ? ranked.map((r) => r.note) : response.results;

  const termsMatchedInTitleOrAttributes = Object.fromEntries(
    terms.map((term) => [term, ranked.filter((r) => r.matchedTerms.includes(term)).length])
  );

  return {
    results: ordered.slice(0, sliceTo),
    searchMode: 'fuzzy',
    fuzzyTerms: terms,
    totalCandidates: response.results.length,
    termsMatchedInTitleOrAttributes,
    note: describeFuzzyRun({
      terms,
      returned: Math.min(ordered.length, sliceTo),
      totalCandidates: response.results.length,
      reranked,
      forced,
    }),
    ...(response.debugInfo ? { debugInfo: response.debugInfo } : {}),
  };
}

/**
 * Run the search, retrying as a ranked OR when the exact query comes back empty.
 *
 * Both call sites route through here so the parameter list cannot drift between the
 * normal path and the noteId-404 path. `allowFuzzy` is false on the latter: a caller
 * who asked for a specific ID does not want an OR-expansion of that ID.
 */
async function runSearchWithFallback(
  client: TriliumClient,
  parsed: SearchArgs,
  effectiveQuery: string,
  originalQuery: string,
  allowFuzzy: boolean
): Promise<Record<string, unknown>> {
  const mode: FuzzyMode = parsed.fuzzy ?? 'auto';
  const eligible = allowFuzzy && isFuzzyEligible(originalQuery, mode);

  if (mode === 'force' && eligible) {
    return runFuzzySearch(client, parsed, extractFuzzyTerms(originalQuery), true);
  }

  const exact = await client.searchNotes({
    ...scopeParams(parsed),
    search: effectiveQuery,
    limit: parsed.limit,
  });

  if (mode === 'force') {
    // Forced, but the query is structured — OR-expanding it would produce something
    // syntactically different and probably invalid. Say so rather than pretend.
    return {
      ...exact,
      searchMode: 'exact',
      note:
        'fuzzy="force" was ignored: this query uses Trilium syntax (attribute, property, ' +
        'id:/title: prefix, or an existing OR) that must not be OR-expanded. Ran it exactly as written.',
    };
  }

  if (!eligible || exact.results.length !== 0) {
    return exact as unknown as Record<string, unknown>;
  }

  try {
    return await runFuzzySearch(client, parsed, extractFuzzyTerms(originalQuery), false);
  } catch {
    // Best-effort retry. A failed rewrite must never turn a successful-but-empty
    // search into a tool error.
    return exact as unknown as Record<string, unknown>;
  }
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
            // Note not found — fall back to regular search, but never fuzzily:
            // an OR-expansion of a note ID is meaningless.
            const result = await runSearchWithFallback(
              client,
              parsed,
              preprocessed.query,
              parsed.query,
              false
            );
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };
          }
          throw error;
        }
      }

      const result = await runSearchWithFallback(
        client,
        parsed,
        preprocessed.query,
        parsed.query,
        true
      );
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

    default:
      return null;
  }
}
