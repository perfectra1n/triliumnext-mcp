/**
 * Preprocesses search queries to handle natural-language OR between fulltext terms.
 *
 * Trilium supports OR between attribute filters (#book or #article) but NOT between
 * bare fulltext terms. This rewrites `meeting or project` into
 * `note.content *=* meeting OR note.content *=* project`.
 */

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
    if (/[=!<>]/.test(token)) return false;
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

export function preprocessSearchQuery(query: string): string {
  const tokens = tokenize(query);
  if (tokens.length === 0) return query;

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

  // Check if any segment is bare fulltext (needs rewriting)
  const hasBareFulltext = segments.some((seg) => isBareFulltextSegment(seg));
  if (!hasBareFulltext) return query;

  // Rewrite: wrap bare fulltext segments, leave attribute segments as-is
  const rewritten = segments.map((seg) => {
    if (isBareFulltextSegment(seg)) {
      return wrapFulltextSegment(seg);
    }
    return seg.join(' ');
  });

  return rewritten.join(' OR ');
}
