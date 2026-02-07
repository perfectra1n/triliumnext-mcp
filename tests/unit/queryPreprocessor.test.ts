import { describe, it, expect } from 'vitest';
import { preprocessSearchQuery } from '../../src/tools/queryPreprocessor.js';

describe('preprocessSearchQuery', () => {
  describe('passthrough (no transformation needed)', () => {
    it('should return simple fulltext queries unchanged', () => {
      expect(preprocessSearchQuery('meeting')).toBe('meeting');
    });

    it('should return multi-word fulltext queries unchanged (implicit AND)', () => {
      expect(preprocessSearchQuery('meeting notes')).toBe('meeting notes');
    });

    it('should return attribute filters unchanged', () => {
      expect(preprocessSearchQuery('#project')).toBe('#project');
    });

    it('should return attribute OR unchanged', () => {
      expect(preprocessSearchQuery('#book or #article')).toBe('#book or #article');
    });

    it('should return property expressions unchanged', () => {
      expect(preprocessSearchQuery('note.title *=* meeting')).toBe('note.title *=* meeting');
    });

    it('should return already-correct property OR unchanged', () => {
      expect(preprocessSearchQuery('note.content *=* foo OR note.content *=* bar'))
        .toBe('note.content *=* foo OR note.content *=* bar');
    });

    it('should return empty-ish queries unchanged', () => {
      expect(preprocessSearchQuery('')).toBe('');
      expect(preprocessSearchQuery('   ')).toBe('   ');
    });
  });

  describe('bare fulltext OR rewriting', () => {
    it('should rewrite two bare terms with OR', () => {
      expect(preprocessSearchQuery('authentication OR authorization'))
        .toBe('note.content *=* authentication OR note.content *=* authorization');
    });

    it('should handle lowercase or', () => {
      expect(preprocessSearchQuery('meeting or project'))
        .toBe('note.content *=* meeting OR note.content *=* project');
    });

    it('should handle mixed case Or', () => {
      expect(preprocessSearchQuery('bug Or issue'))
        .toBe('note.content *=* bug OR note.content *=* issue');
    });

    it('should rewrite three bare terms with OR', () => {
      expect(preprocessSearchQuery('bug OR issue OR defect'))
        .toBe('note.content *=* bug OR note.content *=* issue OR note.content *=* defect');
    });

    it('should rewrite quoted phrases with OR', () => {
      expect(preprocessSearchQuery('"meeting notes" OR "project updates"'))
        .toBe('note.content *=* "meeting notes" OR note.content *=* "project updates"');
    });

    it('should rewrite mixed single and quoted terms', () => {
      expect(preprocessSearchQuery('authentication OR "access control"'))
        .toBe('note.content *=* authentication OR note.content *=* "access control"');
    });
  });

  describe('mixed fulltext and attribute OR', () => {
    it('should wrap only the bare side of mixed OR', () => {
      expect(preprocessSearchQuery('meeting or #project'))
        .toBe('note.content *=* meeting OR #project');
    });

    it('should wrap bare side with property expression on other', () => {
      expect(preprocessSearchQuery('meeting or note.title *=* project'))
        .toBe('note.content *=* meeting OR note.title *=* project');
    });
  });

  describe('multi-word bare segments with OR', () => {
    it('should wrap each word in multi-word bare segment', () => {
      expect(preprocessSearchQuery('meeting notes or project updates'))
        .toBe('(note.content *=* meeting AND note.content *=* notes) OR (note.content *=* project AND note.content *=* updates)');
    });

    it('should handle single vs multi-word segments', () => {
      expect(preprocessSearchQuery('auth or "access control" or security'))
        .toBe('note.content *=* auth OR note.content *=* "access control" OR note.content *=* security');
    });
  });

  describe('edge cases', () => {
    it('should handle extra whitespace around OR', () => {
      const result = preprocessSearchQuery('meeting   OR   project');
      expect(result).toBe('note.content *=* meeting OR note.content *=* project');
    });

    it('should not treat "or" inside quoted strings as operator', () => {
      expect(preprocessSearchQuery('"this or that"')).toBe('"this or that"');
    });

    it('should handle OR with negation attribute (leave unchanged)', () => {
      expect(preprocessSearchQuery('#!archived or #!deleted')).toBe('#!archived or #!deleted');
    });

    it('should handle parenthesized attribute expressions (leave unchanged)', () => {
      expect(preprocessSearchQuery('(#year >= 1950 AND #year <= 1960) or #classic'))
        .toBe('(#year >= 1950 AND #year <= 1960) or #classic');
    });

    it('should handle relation syntax OR (leave unchanged)', () => {
      expect(preprocessSearchQuery('~myRelation or ~otherRelation'))
        .toBe('~myRelation or ~otherRelation');
    });

    it('should treat tokens with ! as bare fulltext (not operators)', () => {
      expect(preprocessSearchQuery('important! or urgent!'))
        .toBe('note.content *=* important! OR note.content *=* urgent!');
    });
  });
});
