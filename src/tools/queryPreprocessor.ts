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
 */
function tokenize(query: string): string[] {
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
function isOrOperator(token: string): boolean {
  return token.toLowerCase() === 'or';
}

/**
 * Check if a list of tokens represents a bare fulltext segment
 * (no attribute syntax, no property expressions, no comparison operators).
 */
function isBareFulltextSegment(tokens: string[]): boolean {
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

/**
 * Wrap a title segment in `note.title *=*` form.
 * Automatically quotes multi-word terms.
 */
function wrapTitleSegment(term: string): string {
  // Already quoted
  if (term.startsWith('"') && term.endsWith('"')) {
    return `note.title *=* ${term}`;
  }
  // Multi-word — auto-quote
  if (term.includes(' ')) {
    return `note.title *=* "${term}"`;
  }
  return `note.title *=* ${term}`;
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
    (seg) => isBareFulltextSegment(seg) || (seg.length >= 1 && seg[0].toLowerCase().startsWith('title:'))
  );
  if (!needsRewrite) return query;

  // Rewrite: wrap bare fulltext segments, handle title: segments, leave attribute segments as-is
  const rewritten = segments.map((seg) => {
    // Check for title: prefix within OR segment
    if (seg.length >= 1 && seg[0].toLowerCase().startsWith('title:')) {
      const firstTokenValue = seg[0].slice(6); // strip "title:"
      const rest = seg.slice(1).join(' ');
      const fullTerm = firstTokenValue + (rest ? ' ' + rest : '');
      if (fullTerm.length === 0) return seg.join(' ');
      return wrapTitleSegment(fullTerm);
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

  // Heuristic: single token matching entity ID pattern with at least one digit
  if (tokens.length === 1 && ENTITY_ID_PATTERN.test(tokens[0]) && /\d/.test(tokens[0])) {
    return { type: 'noteIdLookup', query: tokens[0] };
  }

  // Check for title: prefix (non-OR case)
  if (tokens.length >= 1 && tokens[0].toLowerCase().startsWith('title:')) {
    // Check if there are any OR operators
    const hasOr = tokens.some((t) => isOrOperator(t));
    if (!hasOr) {
      const firstTokenValue = tokens[0].slice(6); // strip "title:"
      const rest = tokens.slice(1).join(' ');
      const fullTerm = firstTokenValue + (rest ? ' ' + rest : '');
      if (fullTerm.length > 0) {
        return { type: 'search', query: wrapTitleSegment(fullTerm) };
      }
    }
    // If OR present, fall through to OR rewriting which handles title: segments
  }

  // OR rewriting (handles both bare fulltext and title: segments within OR)
  const rewritten = rewriteOrQueries(query, tokens);
  return { type: 'search', query: rewritten };
}
