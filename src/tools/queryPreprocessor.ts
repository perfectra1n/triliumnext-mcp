/**
 * Preprocesses search queries to handle:
 * - Natural-language OR between fulltext terms
 * - `id:` prefix for direct noteId lookup
 * - `title:` prefix for title-only searching
 *
 * Trilium supports OR between attribute filters (#book or #article) but NOT between
 * bare fulltext terms. This rewrites `meeting or project` into
 * `note.content *=* meeting OR note.content *=* project`.
 */

export interface PreprocessedQuery {
  type: 'search' | 'noteIdLookup';
  query: string;
}

/**
 * Tokenize a query string, keeping quoted phrases as single tokens.
 *
 * The escape grammar is `\\` and `\"` inside a quoted phrase; anything emitting
 * quoted terms back into a Trilium query must escape to match (see
 * `quoteTerm` in fuzzySearch.ts).
 */
export function tokenize(query: string): string[] {
  const tokens: string[] = [];
  const regex = /"(?:[^"\\]|\\.)*"|\S+/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    tokens.push(match[0]);
  }
  return tokens;
}

/**
 * Check if a token is an OR operator (case-insensitive).
 */
export function isOrOperator(token: string): boolean {
  return token.toLowerCase() === 'or';
}

/**
 * Check if a list of tokens represents a bare fulltext segment
 * (no attribute syntax, no property expressions, no comparison operators).
 *
 * This is a heuristic tuned for query *rewriting*, not a validator. It is
 * deliberately asymmetric — it checks `startsWith(')')`, so it catches `)foo`
 * but not `foo)`. Callers using it as a safety gate must add their own stricter
 * check rather than assume it is exhaustive.
 */
export function isBareFulltextSegment(tokens: string[]): boolean {
  return tokens.every((token) => {
    if (token.startsWith('#') || token.startsWith('~')) return false;
    if (token.startsWith('note.')) return false;
    if (token.startsWith('not(')) return false;
    if (/[=<>]/.test(token)) return false;
    if (token.startsWith('(') || token.startsWith(')')) return false;
    return true;
  });
}

/**
 * Wrap a bare fulltext segment in `note.content *=*` form.
 * Single token: `note.content *=* term`
 * Multiple tokens: `(note.content *=* term1 AND note.content *=* term2)`
 */
function wrapFulltextSegment(tokens: string[]): string {
  if (tokens.length === 1) {
    return `note.content *=* ${tokens[0]}`;
  }
  const wrapped = tokens.map((t) => `note.content *=* ${t}`).join(' AND ');
  return `(${wrapped})`;
}

const QUOTED_TOKEN = /^"(?:[^"\\]|\\.)*"$/;

/** Quote a literal for a Trilium query, escaping `\` and `"` (same grammar as `tokenize`). */
function quoteLiteral(term: string): string {
  return `"${term.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Strip the surrounding quotes from a quoted token and undo its escapes. */
function unquoteToken(token: string): string {
  return token.slice(1, -1).replace(/\\(.)/g, '$1');
}

/** Tokens that start a new filter rather than continuing the title text. */
function isFilterToken(token: string): boolean {
  return token.startsWith('#') || token.startsWith('~') || token.startsWith('note.');
}

/**
 * Rewrite a `title:` segment (first token starts with `title:`) into
 * `note.title *=* <term>`. The title text runs until the first `#label`,
 * `~relation` or `note.` token; those trailing filters are kept as-is so
 * `title:meeting #project` means "title contains meeting AND has #project".
 *
 * A single bare word stays unquoted, a single quoted phrase is passed through,
 * and anything else (several words, embedded quotes) becomes one escaped
 * quoted literal. Returns null when there is no title text.
 */
function wrapTitleSegment(tokens: string[]): string | null {
  // Re-tokenize after stripping "title:" — `title:"a b"` tokenizes as
  // `title:"a` + `b"` because the quote is not at a token boundary.
  const words = tokenize(tokens.join(' ').slice(6));
  const filterAt = words.findIndex(isFilterToken);
  const titleWords = filterAt === -1 ? words : words.slice(0, filterAt);
  const trailing = filterAt === -1 ? [] : words.slice(filterAt);
  if (titleWords.length === 0) return null;

  let term: string;
  if (titleWords.length === 1 && QUOTED_TOKEN.test(titleWords[0])) {
    term = titleWords[0];
  } else if (titleWords.length === 1 && !titleWords[0].includes('"')) {
    term = titleWords[0];
  } else {
    const text = titleWords.map((w) => (QUOTED_TOKEN.test(w) ? unquoteToken(w) : w)).join(' ');
    term = quoteLiteral(text);
  }
  return [`note.title *=* ${term}`, ...trailing].join(' ');
}

/**
 * Rewrite bare fulltext OR queries into note.content *=* form.
 */
function rewriteOrQueries(query: string, tokens: string[]): string {
  // Split tokens into segments separated by OR operators
  const segments: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (isOrOperator(token)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }

  // No OR found — return original query unchanged
  if (segments.length <= 1) return query;

  // Check if any segment is bare fulltext or title: prefixed (needs rewriting)
  const needsRewrite = segments.some(
    (seg) =>
      isBareFulltextSegment(seg) || (seg.length >= 1 && seg[0].toLowerCase().startsWith('title:'))
  );
  if (!needsRewrite) return query;

  // Rewrite: wrap bare fulltext segments, handle title: segments, leave attribute segments as-is
  const rewritten = segments.map((seg) => {
    // Check for title: prefix within OR segment
    if (seg.length >= 1 && seg[0].toLowerCase().startsWith('title:')) {
      return wrapTitleSegment(seg) ?? seg.join(' ');
    }
    if (isBareFulltextSegment(seg)) {
      return wrapFulltextSegment(seg);
    }
    return seg.join(' ');
  });

  return rewritten.join(' OR ');
}

const ENTITY_ID_PATTERN = /^[a-zA-Z0-9]{4,32}$/;

export function preprocessSearchQuery(query: string): PreprocessedQuery {
  const tokens = tokenize(query);
  if (tokens.length === 0) return { type: 'search', query };

  // Check for explicit id: prefix
  if (tokens.length >= 1 && tokens[0].toLowerCase().startsWith('id:')) {
    const idValue = tokens.slice(0).join(' ').slice(3).trim();
    if (idValue.length > 0 && ENTITY_ID_PATTERN.test(idValue)) {
      return { type: 'noteIdLookup', query: idValue };
    }
    // Invalid id: value — fall through to regular search
  }

  // Heuristic: single token that looks like a Trilium-generated note ID —
  // exactly 12 alphanumeric chars with at least one digit. Shorter/longer
  // forced IDs (4-32 chars) need the explicit id: prefix so ordinary search
  // terms like "web3" are not intercepted.
  if (tokens.length === 1 && /^[a-zA-Z0-9]{12}$/.test(tokens[0]) && /\d/.test(tokens[0])) {
    return { type: 'noteIdLookup', query: tokens[0] };
  }

  // Check for title: prefix (non-OR case)
  if (tokens.length >= 1 && tokens[0].toLowerCase().startsWith('title:')) {
    // Check if there are any OR operators
    const hasOr = tokens.some((t) => isOrOperator(t));
    if (!hasOr) {
      const wrapped = wrapTitleSegment(tokens);
      if (wrapped !== null) {
        return { type: 'search', query: wrapped };
      }
    }
    // If OR present, fall through to OR rewriting which handles title: segments
  }

  // OR rewriting (handles both bare fulltext and title: segments within OR)
  const rewritten = rewriteOrQueries(query, tokens);
  return { type: 'search', query: rewritten };
}
