/**
 * High-recall fallback for `search_notes`.
 *
 * Trilium's fulltext search is implicit-AND, so a query where a single term is
 * wrong returns nothing at all — the worst outcome for a caller working from
 * partial recall, because zero results carry no signal about which term was bad.
 *
 * This module turns such a query into an OR over its individual terms and ranks
 * the results client-side. Ranking is necessarily title- and attribute-only:
 * ETAPI's search response carries no note content (see `SearchResponse` in
 * types/etapi.ts), and fetching it would cost one HTTP request per candidate.
 *
 * The consequence is important enough to state plainly: a note that matched only
 * in its body scores zero here. It is still returned — ranked low, but never
 * dropped — because Trilium already decided it matched. `rankNotes` sorts; it
 * never filters.
 */

import type { Note } from '../types/etapi.js';
import { isBareFulltextSegment, isOrOperator, tokenize } from './queryPreprocessor.js';

/**
 * Upper bound on terms fed into the OR query. Each term becomes two arms
 * (`note.content` and `note.title`), and `note.content *=*` is an unindexed
 * substring scan — so an uncapped query built from a pasted paragraph would be
 * pathologically expensive.
 */
export const MAX_FUZZY_TERMS = 8;

/** Candidates fetched per result returned, so there is something to rank. */
export const FUZZY_RECALL_MULTIPLIER = 4;

/** Baseline ceiling on the recall window; never clamps below the caller's own limit. */
export const FUZZY_RECALL_CAP = 200;

/** Results returned when the caller expressed no preference. */
export const DEFAULT_FUZZY_RESULT_LIMIT = 50;

/** Matches `searchLimitSchema.max` in validators.ts. */
const SEARCH_LIMIT_CEILING = 10000;

export type FuzzyMode = 'auto' | 'off' | 'force';

export interface RankedNote {
  note: Note;
  score: number;
  matchedTerms: string[];
}

/**
 * Characters that imply structured Trilium query syntax rather than plain fulltext.
 *
 * This is deliberately stricter than `isBareFulltextSegment`, which only inspects
 * token prefixes and so misses e.g. a trailing `)`. Being strictly stricter means
 * that gap cannot leak into the fuzzy path and produce a malformed query.
 */
const STRUCTURED_SYNTAX_RE = /[#~()=<>*]/;

/**
 * Scripts where a single character is a meaningful morpheme, so the ASCII
 * minimum-length rule must not apply. Covers Hiragana, Katakana, CJK Ext-A,
 * CJK Unified, CJK Compatibility Ideographs, halfwidth Katakana, Hangul, and
 * CJK Ext-B and beyond.
 */
const CJK_RE =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ가-힯]|[\u{20000}-\u{2fa1f}]/u;

/** Punctuation stripped from the edges of a bare token, ASCII and CJK alike. */
const EDGE_PUNCTUATION_RE = /^[\s,.;:!?'"、。！？，；：「」『』（）]+|[\s,.;:!?'"、。！？，；：「」『』（）]+$/gu;

/**
 * Normalize for comparison only. NFKC folds full-width forms onto their ASCII
 * equivalents so `Ｎｉａｇａｒａ` matches `niagara`.
 *
 * Note this is asymmetric with Trilium, which matched on raw text. That is
 * acceptable — ranking is a heuristic, and Trilium's matching is not ours to
 * change — but it does mean our notion of "matched" is slightly broader than
 * the one that produced the candidate set.
 */
function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function containsCjk(term: string): boolean {
  return CJK_RE.test(term);
}

/**
 * Split a free-form query into distinct search terms.
 *
 * Quoted phrases survive as single terms regardless of length — an explicitly
 * quoted phrase is user intent, and the minimum-length rule must not override it.
 */
export function extractFuzzyTerms(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const token of tokenize(query)) {
    if (isOrOperator(token)) continue;

    let term: string;
    if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
      // Strip the outer quotes, then unwind the `\\` / `\"` escape grammar
      // that tokenize() accepts.
      term = token.slice(1, -1).replace(/\\(.)/g, '$1').trim();
    } else {
      term = token.replace(EDGE_PUNCTUATION_RE, '');
      // A single ASCII character is a substring of nearly every note and would
      // drown the signal; a single CJK character is a real morpheme.
      if (term.length < 2 && !containsCjk(term)) continue;
    }

    if (term.length === 0) continue;

    // Deduplicate with toLowerCase, not toLocaleLowerCase — the latter is
    // locale-dependent (Turkish dotless i) and would make results vary by host.
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);

    if (terms.length === MAX_FUZZY_TERMS) break;
  }

  return terms;
}

/**
 * Whether a query may be retried as a ranked OR search.
 *
 * Evaluated against the ORIGINAL user query, never the preprocessed one:
 * preprocessing may already have rewritten `title:x` into `note.title *=* x`,
 * which would then look ineligible for the wrong reason.
 */
export function isFuzzyEligible(query: string, mode: FuzzyMode): boolean {
  if (mode === 'off') return false;

  const tokens = tokenize(query);
  if (tokens.length === 0) return false;

  // Structured syntax: attribute filters, property expressions, operators,
  // grouping. OR-expanding these produces a different and probably invalid query.
  if (STRUCTURED_SYNTAX_RE.test(query)) return false;
  if (!isBareFulltextSegment(tokens)) return false;

  // Already maximum-recall — zero results means genuinely nothing.
  if (tokens.some(isOrOperator)) return false;

  // Explicit scoping. Widening what the caller deliberately narrowed would be
  // the opposite of helpful.
  const first = tokens[0].toLowerCase();
  if (first.startsWith('title:') || first.startsWith('id:')) return false;

  // With one term the OR query has a single arm, making the retry a duplicate of
  // the search that just failed. `force` is an explicit request, so it may proceed.
  const minimumTerms = mode === 'force' ? 1 : 2;
  return extractFuzzyTerms(query).length >= minimumTerms;
}

/**
 * Quote a term for embedding in a Trilium query.
 *
 * Always quotes, with no "only if it contains a space" branch — one code path is
 * one thing to get right. Backslashes are escaped before quotes, otherwise the
 * second replace would double-escape what the first just introduced.
 */
export function quoteTerm(term: string): string {
  return `"${term.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build the high-recall OR query.
 *
 * Both `note.content` and `note.title` arms are emitted per term. Trilium's
 * content does not include the title, and the motivating case — a half-remembered
 * note — is overwhelmingly a half-remembered title. The title arms also keep the
 * candidate set aligned with what the ranker can actually score.
 */
export function buildFuzzyQuery(terms: string[]): string {
  return terms
    .flatMap((term) => {
      const quoted = quoteTerm(term);
      return [`note.content *=* ${quoted}`, `note.title *=* ${quoted}`];
    })
    .join(' OR ');
}

function attributeMatches(note: Note, normalizedTerm: string): boolean {
  for (const attr of note.attributes ?? []) {
    if (
      normalize(attr.name ?? '').includes(normalizedTerm) ||
      normalize(attr.value ?? '').includes(normalizedTerm)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Order candidates by how much title/attribute evidence they show for the terms.
 *
 * This is a sort, never a filter: the returned array always has the same length
 * as the input. A score of zero does not mean the note is a bad match — it means
 * this function, which cannot see note content, has no evidence either way.
 */
export function rankNotes(notes: Note[], terms: string[]): RankedNote[] {
  const normalizedTerms = terms.map((term) => ({ raw: term, norm: normalize(term) }));
  const normalizedQuery = normalizedTerms.map((t) => t.norm).join(' ');

  const ranked: RankedNote[] = notes.map((note) => {
    const title = normalize(note.title ?? '');
    const matchedTerms: string[] = [];
    let score = 0;
    let titleHits = 0;
    let startsWithTerm = false;

    for (const { raw, norm } of normalizedTerms) {
      let matched = false;

      if (norm.length > 0 && title.includes(norm)) {
        score += 10;
        titleHits += 1;
        matched = true;
        if (title.startsWith(norm)) startsWithTerm = true;
      }

      // Any label or relation, matched on name or value — not just labels
      // literally named "tag".
      if (norm.length > 0 && attributeMatches(note, norm)) {
        score += 4;
        matched = true;
      }

      if (matched) matchedTerms.push(raw);
    }

    // Approximates the AND the caller originally asked for: a note carrying every
    // term in its title is almost certainly the one they meant.
    if (normalizedTerms.length > 0 && titleHits === normalizedTerms.length) score += 15;

    if (normalizedTerms.length > 0) {
      score += Math.round((20 * matchedTerms.length) / normalizedTerms.length);
    }

    if (startsWithTerm) score += 3;
    if (title.length > 0 && (title === normalizedQuery || normalizedTerms.some((t) => t.norm === title))) {
      score += 5;
    }

    return { note, score, matchedTerms };
  });

  return ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.matchedTerms.length !== a.matchedTerms.length) {
      return b.matchedTerms.length - a.matchedTerms.length;
    }
    // A shorter title that still matches is the more specific hit.
    const aLen = (a.note.title ?? '').length;
    const bLen = (b.note.title ?? '').length;
    if (aLen !== bLen) return aLen - bLen;
    const aMod = a.note.utcDateModified ?? '';
    const bMod = b.note.utcDateModified ?? '';
    if (aMod !== bMod) return bMod.localeCompare(aMod);
    // Mandatory final tie-break: Array.sort is stable, so without a total ordering
    // the caller's input order would leak into the output and this would not be a
    // pure function of the input set.
    return (a.note.noteId ?? '').localeCompare(b.note.noteId ?? '');
  });
}

/**
 * Decide how many candidates to fetch and how many to return.
 *
 * Over-fetching is what makes ranking meaningful — you cannot rank ten results
 * into a better ten. The `Math.max(..., sliceTo)` guards ensure a caller asking
 * for more than the baseline cap is never silently short-changed.
 */
export function resolveFuzzyLimit(callerLimit?: number): { fetchLimit: number; sliceTo: number } {
  const sliceTo = callerLimit ?? DEFAULT_FUZZY_RESULT_LIMIT;
  const fetchLimit = Math.min(
    Math.max(sliceTo * FUZZY_RECALL_MULTIPLIER, sliceTo),
    Math.max(FUZZY_RECALL_CAP, sliceTo),
    SEARCH_LIMIT_CEILING
  );
  return { fetchLimit, sliceTo };
}
