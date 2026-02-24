import { describe, it, expect } from 'vitest';
import { preprocessSearchQuery } from '../../src/tools/queryPreprocessor.js';

describe('preprocessSearchQuery', () => {
  describe('passthrough (no transformation needed)', () => {
    it('should return simple fulltext queries unchanged', () => {
      expect(preprocessSearchQuery('meeting')).toEqual({ type: 'search', query: 'meeting' });
    });

    it('should return multi-word fulltext queries unchanged (implicit AND)', () => {
      expect(preprocessSearchQuery('meeting notes')).toEqual({ type: 'search', query: 'meeting notes' });
    });

    it('should return attribute filters unchanged', () => {
      expect(preprocessSearchQuery('#project')).toEqual({ type: 'search', query: '#project' });
    });

    it('should return attribute OR unchanged', () => {
      expect(preprocessSearchQuery('#book or #article')).toEqual({ type: 'search', query: '#book or #article' });
    });

    it('should return property expressions unchanged', () => {
      expect(preprocessSearchQuery('note.title *=* meeting')).toEqual({ type: 'search', query: 'note.title *=* meeting' });
    });

    it('should return already-correct property OR unchanged', () => {
      expect(preprocessSearchQuery('note.content *=* foo OR note.content *=* bar'))
        .toEqual({ type: 'search', query: 'note.content *=* foo OR note.content *=* bar' });
    });

    it('should return empty-ish queries unchanged', () => {
      expect(preprocessSearchQuery('')).toEqual({ type: 'search', query: '' });
      expect(preprocessSearchQuery('   ')).toEqual({ type: 'search', query: '   ' });
    });
  });

  describe('bare fulltext OR rewriting', () => {
    it('should rewrite two bare terms with OR', () => {
      expect(preprocessSearchQuery('authentication OR authorization'))
        .toEqual({ type: 'search', query: 'note.content *=* authentication OR note.content *=* authorization' });
    });

    it('should handle lowercase or', () => {
      expect(preprocessSearchQuery('meeting or project'))
        .toEqual({ type: 'search', query: 'note.content *=* meeting OR note.content *=* project' });
    });

    it('should handle mixed case Or', () => {
      expect(preprocessSearchQuery('bug Or issue'))
        .toEqual({ type: 'search', query: 'note.content *=* bug OR note.content *=* issue' });
    });

    it('should rewrite three bare terms with OR', () => {
      expect(preprocessSearchQuery('bug OR issue OR defect'))
        .toEqual({ type: 'search', query: 'note.content *=* bug OR note.content *=* issue OR note.content *=* defect' });
    });

    it('should rewrite quoted phrases with OR', () => {
      expect(preprocessSearchQuery('"meeting notes" OR "project updates"'))
        .toEqual({ type: 'search', query: 'note.content *=* "meeting notes" OR note.content *=* "project updates"' });
    });

    it('should rewrite mixed single and quoted terms', () => {
      expect(preprocessSearchQuery('authentication OR "access control"'))
        .toEqual({ type: 'search', query: 'note.content *=* authentication OR note.content *=* "access control"' });
    });
  });

  describe('mixed fulltext and attribute OR', () => {
    it('should wrap only the bare side of mixed OR', () => {
      expect(preprocessSearchQuery('meeting or #project'))
        .toEqual({ type: 'search', query: 'note.content *=* meeting OR #project' });
    });

    it('should wrap bare side with property expression on other', () => {
      expect(preprocessSearchQuery('meeting or note.title *=* project'))
        .toEqual({ type: 'search', query: 'note.content *=* meeting OR note.title *=* project' });
    });
  });

  describe('multi-word bare segments with OR', () => {
    it('should wrap each word in multi-word bare segment', () => {
      expect(preprocessSearchQuery('meeting notes or project updates'))
        .toEqual({ type: 'search', query: '(note.content *=* meeting AND note.content *=* notes) OR (note.content *=* project AND note.content *=* updates)' });
    });

    it('should handle single vs multi-word segments', () => {
      expect(preprocessSearchQuery('auth or "access control" or security'))
        .toEqual({ type: 'search', query: 'note.content *=* auth OR note.content *=* "access control" OR note.content *=* security' });
    });
  });

  describe('edge cases', () => {
    it('should handle extra whitespace around OR', () => {
      const result = preprocessSearchQuery('meeting   OR   project');
      expect(result).toEqual({ type: 'search', query: 'note.content *=* meeting OR note.content *=* project' });
    });

    it('should not treat "or" inside quoted strings as operator', () => {
      expect(preprocessSearchQuery('"this or that"')).toEqual({ type: 'search', query: '"this or that"' });
    });

    it('should handle OR with negation attribute (leave unchanged)', () => {
      expect(preprocessSearchQuery('#!archived or #!deleted')).toEqual({ type: 'search', query: '#!archived or #!deleted' });
    });

    it('should handle parenthesized attribute expressions (leave unchanged)', () => {
      expect(preprocessSearchQuery('(#year >= 1950 AND #year <= 1960) or #classic'))
        .toEqual({ type: 'search', query: '(#year >= 1950 AND #year <= 1960) or #classic' });
    });

    it('should handle relation syntax OR (leave unchanged)', () => {
      expect(preprocessSearchQuery('~myRelation or ~otherRelation'))
        .toEqual({ type: 'search', query: '~myRelation or ~otherRelation' });
    });

    it('should treat tokens with ! as bare fulltext (not operators)', () => {
      expect(preprocessSearchQuery('important! or urgent!'))
        .toEqual({ type: 'search', query: 'note.content *=* important! OR note.content *=* urgent!' });
    });
  });

  describe('noteId detection', () => {
    it('should detect explicit id: prefix', () => {
      expect(preprocessSearchQuery('id:abc123')).toEqual({ type: 'noteIdLookup', query: 'abc123' });
    });

    it('should detect id: prefix case-insensitively', () => {
      expect(preprocessSearchQuery('ID:abc123')).toEqual({ type: 'noteIdLookup', query: 'abc123' });
    });

    it('should handle id: with spaces after colon via trim', () => {
      // "id: abc123" tokenizes as ["id:", "abc123"], joined = "id: abc123", slice(3)=" abc123", trim="abc123"
      expect(preprocessSearchQuery('id: abc123')).toEqual({ type: 'noteIdLookup', query: 'abc123' });
    });

    it('should detect single alphanumeric token with digits as noteId (heuristic)', () => {
      expect(preprocessSearchQuery('abc123def')).toEqual({ type: 'noteIdLookup', query: 'abc123def' });
    });

    it('should detect long noteId-like tokens', () => {
      expect(preprocessSearchQuery('note1234abcdef5678')).toEqual({ type: 'noteIdLookup', query: 'note1234abcdef5678' });
    });

    it('should NOT treat pure-alpha words as noteId', () => {
      expect(preprocessSearchQuery('meeting')).toEqual({ type: 'search', query: 'meeting' });
    });

    it('should NOT treat pure-digit tokens as noteId if too short', () => {
      expect(preprocessSearchQuery('123')).toEqual({ type: 'search', query: '123' });
    });

    it('should detect 4-char token with digit as noteId', () => {
      expect(preprocessSearchQuery('ab1c')).toEqual({ type: 'noteIdLookup', query: 'ab1c' });
    });

    it('should NOT treat multi-word queries as noteId', () => {
      expect(preprocessSearchQuery('abc123 def456')).toEqual({ type: 'search', query: 'abc123 def456' });
    });

    it('should handle empty id: value', () => {
      // "id:" alone — no value after colon, falls through to search
      expect(preprocessSearchQuery('id:')).toEqual({ type: 'search', query: 'id:' });
    });

    it('should reject id: with invalid chars', () => {
      expect(preprocessSearchQuery('id:abc-123')).toEqual({ type: 'search', query: 'id:abc-123' });
    });

    it('should reject id: with too-short value', () => {
      expect(preprocessSearchQuery('id:ab')).toEqual({ type: 'search', query: 'id:ab' });
    });

    it('should reject id: with too-long value (>32 chars)', () => {
      const longId = 'a'.repeat(33);
      expect(preprocessSearchQuery(`id:${longId}`)).toEqual({ type: 'search', query: `id:${longId}` });
    });
  });

  describe('title: prefix rewriting', () => {
    it('should rewrite simple title search', () => {
      expect(preprocessSearchQuery('title:meeting')).toEqual({ type: 'search', query: 'note.title *=* meeting' });
    });

    it('should auto-quote multi-word title search', () => {
      expect(preprocessSearchQuery('title:meeting notes')).toEqual({ type: 'search', query: 'note.title *=* "meeting notes"' });
    });

    it('should preserve already-quoted title search', () => {
      expect(preprocessSearchQuery('title:"meeting notes"')).toEqual({ type: 'search', query: 'note.title *=* "meeting notes"' });
    });

    it('should handle title OR title', () => {
      expect(preprocessSearchQuery('title:meeting or title:project')).toEqual({
        type: 'search',
        query: 'note.title *=* meeting OR note.title *=* project',
      });
    });

    it('should handle mixed title and fulltext OR', () => {
      expect(preprocessSearchQuery('title:meeting or project')).toEqual({
        type: 'search',
        query: 'note.title *=* meeting OR note.content *=* project',
      });
    });

    it('should handle case-insensitive prefix', () => {
      expect(preprocessSearchQuery('Title:meeting')).toEqual({ type: 'search', query: 'note.title *=* meeting' });
      expect(preprocessSearchQuery('TITLE:meeting')).toEqual({ type: 'search', query: 'note.title *=* meeting' });
    });

    it('should handle empty title value', () => {
      // "title:" alone — no value, falls through
      expect(preprocessSearchQuery('title:')).toEqual({ type: 'search', query: 'title:' });
    });
  });
});
