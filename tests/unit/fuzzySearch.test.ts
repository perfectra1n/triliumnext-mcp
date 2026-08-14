import { describe, it, expect } from 'vitest';
import {
  MAX_FUZZY_TERMS,
  DEFAULT_FUZZY_RESULT_LIMIT,
  extractFuzzyTerms,
  isFuzzyEligible,
  quoteTerm,
  buildFuzzyQuery,
  rankNotes,
  resolveFuzzyLimit,
} from '../../src/tools/fuzzySearch.js';
import type { Attribute, Note } from '../../src/types/etapi.js';

// ============================================================================
// Fixtures
// ============================================================================

let noteSeq = 0;

function makeNote(partial: Partial<Note> = {}): Note {
  noteSeq += 1;
  return {
    noteId: `note${String(noteSeq).padStart(4, '0')}`,
    title: 'Untitled',
    type: 'text',
    mime: 'text/html',
    isProtected: false,
    attributes: [],
    parentNoteIds: ['root'],
    childNoteIds: [],
    parentBranchIds: ['branch1'],
    childBranchIds: [],
    dateCreated: '2026-01-01 00:00:00.000+0000',
    dateModified: '2026-01-01 00:00:00.000+0000',
    utcDateCreated: '2026-01-01T00:00:00.000Z',
    utcDateModified: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function attribute(type: 'label' | 'relation', name: string, value: string): Attribute {
  return {
    attributeId: `${type}_${name}`,
    noteId: 'n',
    type,
    name,
    value,
    position: 10,
    isInheritable: false,
    utcDateModified: '2026-01-01T00:00:00.000Z',
  };
}

const label = (name: string, value: string) => attribute('label', name, value);
const relation = (name: string, value: string) => attribute('relation', name, value);

const titlesOf = (notes: Note[]) => notes.map((n) => n.title);

// ============================================================================
// extractFuzzyTerms
// ============================================================================

describe('extractFuzzyTerms', () => {
  it('splits a mixed CJK/ASCII query into terms', () => {
    expect(extractFuzzyTerms('体积云 Niagara 教程')).toEqual(['体积云', 'Niagara', '教程']);
  });

  it('keeps single-character CJK terms', () => {
    expect(extractFuzzyTerms('的 中 文')).toEqual(['的', '中', '文']);
  });

  it('drops single-character ASCII terms', () => {
    expect(extractFuzzyTerms('a b cat')).toEqual(['cat']);
  });

  it('keeps a quoted phrase as one term', () => {
    expect(extractFuzzyTerms('"meeting notes" project')).toEqual(['meeting notes', 'project']);
  });

  it('unescapes quotes inside a quoted phrase', () => {
    expect(extractFuzzyTerms('"say \\"hi\\"" project')).toEqual(['say "hi"', 'project']);
  });

  it('deduplicates case-insensitively, preserving first-seen casing', () => {
    expect(extractFuzzyTerms('Meeting meeting MEETING notes')).toEqual(['Meeting', 'notes']);
  });

  it('strips CJK trailing punctuation', () => {
    expect(extractFuzzyTerms('教程。 体积云、')).toEqual(['教程', '体积云']);
  });

  it('strips ASCII surrounding punctuation', () => {
    expect(extractFuzzyTerms('urgent! important,')).toEqual(['urgent', 'important']);
  });

  it('caps the number of terms', () => {
    const many = Array.from({ length: 20 }, (_, i) => `term${i}`).join(' ');
    expect(extractFuzzyTerms(many)).toHaveLength(MAX_FUZZY_TERMS);
  });

  it('returns nothing for empty or whitespace-only input', () => {
    expect(extractFuzzyTerms('')).toEqual([]);
    expect(extractFuzzyTerms('   ')).toEqual([]);
  });
});

// ============================================================================
// isFuzzyEligible
// ============================================================================

describe('isFuzzyEligible', () => {
  describe('auto mode', () => {
    it.each([['meeting notes'], ['体积云 Niagara 教程'], ['"exact phrase" other']])(
      'accepts plain fulltext: %s',
      (query) => {
        expect(isFuzzyEligible(query, 'auto')).toBe(true);
      }
    );

    it('rejects a single-term query (the OR retry would be a duplicate)', () => {
      expect(isFuzzyEligible('meeting', 'auto')).toBe(false);
    });

    it('rejects a query whose tokens all fall below the term threshold', () => {
      expect(isFuzzyEligible('a b', 'auto')).toBe(false);
    });

    it.each([
      ['#project'],
      ['#status = active'],
      ['note.title *=* x'],
      ['~rel foo'],
      ['(a b) c'],
      ['not(#x) y'],
    ])('rejects structured query syntax: %s', (query) => {
      expect(isFuzzyEligible(query, 'auto')).toBe(false);
    });

    it('rejects a trailing paren that isBareFulltextSegment would miss', () => {
      expect(isFuzzyEligible('foo) bar', 'auto')).toBe(false);
    });

    it.each([['a or b'], ['a OR b']])('rejects an already-OR query: %s', (query) => {
      expect(isFuzzyEligible(query, 'auto')).toBe(false);
    });

    it.each([['title:meeting notes'], ['id:abc123'], ['abc123def']])(
      'rejects explicitly scoped lookups: %s',
      (query) => {
        expect(isFuzzyEligible(query, 'auto')).toBe(false);
      }
    );

    it.each([[''], ['   ']])('rejects empty input: %s', (query) => {
      expect(isFuzzyEligible(query, 'auto')).toBe(false);
    });
  });

  describe('force mode', () => {
    it('accepts a single-term query', () => {
      expect(isFuzzyEligible('meeting', 'force')).toBe(true);
    });

    it('still rejects structured query syntax', () => {
      expect(isFuzzyEligible('#project', 'force')).toBe(false);
      expect(isFuzzyEligible('title:meeting notes', 'force')).toBe(false);
    });

    it('still rejects empty input', () => {
      expect(isFuzzyEligible('   ', 'force')).toBe(false);
    });
  });

  describe('off mode', () => {
    it('is never eligible', () => {
      expect(isFuzzyEligible('meeting notes', 'off')).toBe(false);
    });
  });
});

// ============================================================================
// quoteTerm / buildFuzzyQuery
// ============================================================================

describe('quoteTerm', () => {
  it('quotes a plain term', () => {
    expect(quoteTerm('meeting')).toBe('"meeting"');
  });

  it('quotes a multi-word phrase', () => {
    expect(quoteTerm('meeting notes')).toBe('"meeting notes"');
  });

  it('escapes embedded double quotes', () => {
    expect(quoteTerm('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('escapes backslashes before quotes, so they do not double-escape', () => {
    expect(quoteTerm('back\\slash')).toBe('"back\\\\slash"');
    expect(quoteTerm('mix\\"both')).toBe('"mix\\\\\\"both"');
  });

  it('quotes CJK terms', () => {
    expect(quoteTerm('体积云')).toBe('"体积云"');
  });
});

describe('buildFuzzyQuery', () => {
  it('emits content and title arms for each term, OR-joined', () => {
    expect(buildFuzzyQuery(['cat', 'dog'])).toBe(
      'note.content *=* "cat" OR note.title *=* "cat" OR ' +
        'note.content *=* "dog" OR note.title *=* "dog"'
    );
  });

  it('escapes terms it embeds', () => {
    expect(buildFuzzyQuery(['say "hi"'])).toBe(
      'note.content *=* "say \\"hi\\"" OR note.title *=* "say \\"hi\\""'
    );
  });
});

// ============================================================================
// rankNotes
// ============================================================================

describe('rankNotes', () => {
  // This is the headline regression guard against PR #55, whose ranker only counted
  // title hits and then filtered on that count — silently discarding every note that
  // matched on content. Trilium already decided these notes matched; ranking may
  // reorder them but must never drop them.
  it('never drops notes that have no title or attribute evidence', () => {
    const notes = [
      makeNote({ title: 'Completely unrelated' }),
      makeNote({ title: 'Also unrelated' }),
      makeNote({ title: 'Still unrelated' }),
    ];
    const ranked = rankNotes(notes, ['体积云', 'Niagara']);
    expect(ranked).toHaveLength(3);
  });

  it('returns the original note objects by reference, unmodified', () => {
    const target = makeNote({ title: 'Niagara particles' });
    const notes = [makeNote({ title: 'Unrelated' }), target];
    const ranked = rankNotes(notes, ['niagara']);

    expect(ranked[0].note).toBe(target);
    expect(Object.keys(ranked[0].note).sort()).toEqual(Object.keys(makeNote()).sort());
    expect(ranked[0].note).not.toHaveProperty('_score');
    expect(ranked[0].note).not.toHaveProperty('_matchedTerms');
  });

  it('ranks all-terms-in-title above one-term-in-title above attribute-only above nothing', () => {
    const nothing = makeNote({ title: 'Unrelated' });
    const attrOnly = makeNote({ title: 'Unrelated too', attributes: [label('topic', 'niagara')] });
    const oneTerm = makeNote({ title: 'Niagara basics' });
    const allTerms = makeNote({ title: 'Niagara 教程 walkthrough' });

    const ranked = rankNotes([nothing, attrOnly, oneTerm, allTerms], ['niagara', '教程']);
    expect(titlesOf(ranked.map((r) => r.note))).toEqual([
      'Niagara 教程 walkthrough',
      'Niagara basics',
      'Unrelated too',
      'Unrelated',
    ]);
  });

  it('scores relation attributes, not just labels', () => {
    const withRelation = makeNote({ title: 'Zed', attributes: [relation('template', 'niagara')] });
    const without = makeNote({ title: 'Alpha' });
    const ranked = rankNotes([without, withRelation], ['niagara']);
    expect(ranked[0].note).toBe(withRelation);
  });

  it('scores an attribute name, not just its value', () => {
    const byName = makeNote({ title: 'Zed', attributes: [label('niagara', 'whatever')] });
    const without = makeNote({ title: 'Alpha' });
    const ranked = rankNotes([without, byName], ['niagara']);
    expect(ranked[0].note).toBe(byName);
  });

  it('scores labels of any name, not only ones named "tag"', () => {
    const arbitrary = makeNote({ title: 'Zed', attributes: [label('anything', 'niagara')] });
    const without = makeNote({ title: 'Alpha' });
    const ranked = rankNotes([without, arbitrary], ['niagara']);
    expect(ranked[0].note).toBe(arbitrary);
  });

  it('matches titles case-insensitively', () => {
    const upper = makeNote({ title: 'NIAGARA GUIDE' });
    const ranked = rankNotes([makeNote({ title: 'Unrelated' }), upper], ['niagara']);
    expect(ranked[0].note).toBe(upper);
  });

  it('treats full-width and half-width characters as equivalent (NFKC)', () => {
    const fullWidth = makeNote({ title: 'Ｎｉａｇａｒａ 教程' });
    const ranked = rankNotes([makeNote({ title: 'Unrelated' }), fullWidth], ['niagara']);
    expect(ranked[0].note).toBe(fullWidth);
  });

  it('prefers the shorter title when scores tie', () => {
    // Both match the single term, both start with it, neither equals it exactly —
    // so every scoring signal is identical and only the length tie-break separates them.
    const short = makeNote({ title: 'Niagara guide' });
    const long = makeNote({ title: 'Niagara guidebook extended' });
    const ranked = rankNotes([long, short], ['niagara']);
    expect(ranked[0].note).toBe(short);
  });

  it('produces the same ordering regardless of input order', () => {
    const notes = [
      makeNote({ title: 'Niagara 教程 deep dive' }),
      makeNote({ title: 'Unrelated' }),
      makeNote({ title: 'Niagara basics' }),
      makeNote({ title: 'Another unrelated' }),
    ];
    const forward = rankNotes(notes, ['niagara', '教程']).map((r) => r.note.noteId);
    const reversed = rankNotes([...notes].reverse(), ['niagara', '教程']).map((r) => r.note.noteId);
    expect(reversed).toEqual(forward);
  });

  it('reports which terms each note matched', () => {
    const note = makeNote({ title: 'Niagara guide', attributes: [label('topic', '教程')] });
    const [ranked] = rankNotes([note], ['niagara', '教程', 'unrelated']);
    expect(ranked.matchedTerms.sort()).toEqual(['niagara', '教程']);
  });

  it('tolerates missing attributes and title without throwing', () => {
    const malformed = { ...makeNote(), attributes: undefined, title: undefined } as unknown as Note;
    expect(() => rankNotes([malformed], ['niagara'])).not.toThrow();
    expect(rankNotes([malformed], ['niagara'])).toHaveLength(1);
  });

  it('returns an empty array for no notes', () => {
    expect(rankNotes([], ['niagara'])).toEqual([]);
  });
});

// ============================================================================
// resolveFuzzyLimit
// ============================================================================

describe('resolveFuzzyLimit', () => {
  it('over-fetches by default so there is something to rank', () => {
    expect(resolveFuzzyLimit(undefined)).toEqual({
      fetchLimit: 200,
      sliceTo: DEFAULT_FUZZY_RESULT_LIMIT,
    });
  });

  it('scales the recall window with a small caller limit', () => {
    expect(resolveFuzzyLimit(10)).toEqual({ fetchLimit: 40, sliceTo: 10 });
  });

  it('never fetches fewer candidates than the caller asked to receive', () => {
    // PR #55 hardcoded 200, silently capping a caller who asked for 500.
    const { fetchLimit, sliceTo } = resolveFuzzyLimit(500);
    expect(sliceTo).toBe(500);
    expect(fetchLimit).toBeGreaterThanOrEqual(500);
  });

  it('never exceeds the schema ceiling', () => {
    expect(resolveFuzzyLimit(10000).fetchLimit).toBeLessThanOrEqual(10000);
  });

  it('always fetches at least as many as it returns', () => {
    for (const limit of [1, 5, 25, 50, 199, 200, 201, 1000, 9999, 10000]) {
      const { fetchLimit, sliceTo } = resolveFuzzyLimit(limit);
      expect(fetchLimit).toBeGreaterThanOrEqual(sliceTo);
    }
  });
});
