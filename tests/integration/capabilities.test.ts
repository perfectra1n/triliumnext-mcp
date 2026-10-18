import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TriliumClient } from '../../src/client/trilium.js';
import { handleNoteTool } from '../../src/tools/notes.js';
import { handleOrganizationTool } from '../../src/tools/organization.js';
import { handleRevisionTool } from '../../src/tools/revisions.js';
import { handleSearchTool } from '../../src/tools/search.js';
import { handleCalendarTool } from '../../src/tools/calendar.js';
import { handleSystemTool } from '../../src/tools/system.js';
import { setupIntegrationTests, stopTriliumContainer } from './setup.js';

type ToolResult = { content: Array<{ type: string; text?: string }> } | null;
const json = (r: ToolResult, i = 0) => JSON.parse((r?.content[i] as { text: string }).text);

describe('Capability expansion (live Trilium)', () => {
  let client: TriliumClient;

  async function note(title: string, parentNoteId = 'root', content = '<p>x</p>') {
    const { note } = await client.createNote({ parentNoteId, title, type: 'text', content });
    return note.noteId;
  }

  beforeAll(async () => {
    client = await setupIntegrationTests();
  }, 120000);

  afterAll(async () => {
    await stopTriliumContainer();
  });

  describe('organize_note move safety', () => {
    it('moving a note onto its current parent keeps the note (upsert regression)', async () => {
      const parent = await note('Move Parent');
      const child = await note('Move Child', parent);

      const result = await handleOrganizationTool(client, 'organize_note', {
        action: 'move',
        noteId: child,
        newParentNoteId: parent,
      });

      expect(json(result).removedBranchId).toBeNull();
      const after = await client.getNote(child);
      expect(after.parentNoteIds).toEqual([parent]);
    });

    it('moves only the requested clone', async () => {
      const a = await note('Clone Parent A');
      const b = await note('Clone Parent B');
      const dest = await note('Clone Destination');
      const child = await note('Cloned Child', a);
      await client.createBranch({ noteId: child, parentNoteId: b });

      await expect(
        handleOrganizationTool(client, 'organize_note', {
          action: 'move',
          noteId: child,
          newParentNoteId: dest,
        })
      ).rejects.toThrow(/fromParentNoteId/);

      await handleOrganizationTool(client, 'organize_note', {
        action: 'move',
        noteId: child,
        newParentNoteId: dest,
        fromParentNoteId: b,
      });
      const after = await client.getNote(child);
      expect(after.parentNoteIds.sort()).toEqual([a, dest].sort());
    });
  });

  describe('note links', () => {
    it('note: placeholders become indexed reference links, found as backlinks', async () => {
      const folder = await note('Links Folder');
      const target = await note('Link Target', folder);

      const created = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'Link Source',
        type: 'text',
        format: 'markdown',
        content: `See [](note:${target}) for details.`,
      });
      const sourceId = json(created).note.noteId as string;

      const body = await client.getNoteContent(sourceId);
      expect(body).toContain(`data-note-path="root/${folder}/${target}"`);
      expect(body).toContain('>Link Target</a>');

      // The indexing re-save makes Trilium record the internalLink relation.
      const source = await client.getNote(sourceId);
      expect(source.attributes.some((a) => a.name === 'internalLink' && a.value === target)).toBe(
        true
      );

      const meta = json(
        await handleNoteTool(client, 'get_note', {
          noteId: target,
          include_content: false,
          include_path: true,
          include_backlinks: true,
        })
      );
      expect(meta.paths).toEqual([
        { path: `root/${folder}/${target}`, breadcrumb: 'root > Links Folder > Link Target' },
      ]);
      expect(meta.backlinks).toContainEqual({ noteId: sourceId, title: 'Link Source' });
    });

    it('rejects a link to a note that does not exist, creating nothing', async () => {
      await expect(
        handleNoteTool(client, 'create_note', {
          parentNoteId: 'root',
          title: 'Dangling Link',
          type: 'text',
          content: '<a href="note:doesNotExist1">x</a>',
        })
      ).rejects.toMatchObject({ status: 404 });
      const search = await client.searchNotes({ search: 'title:"Dangling Link"' });
      expect(search.results).toHaveLength(0);
    });
  });

  describe('restore_revision', () => {
    it('restores content and title, snapshotting the current state first', async () => {
      const id = await note('Rev Original', 'root', '<p>version one</p>');
      await client.createRevision(id);
      await client.updateNoteContent(id, '<p>version two</p>');
      await client.updateNote(id, { title: 'Rev Renamed' });

      const [revision] = await client.getNoteRevisions(id);
      const before = (await client.getNoteRevisions(id)).length;
      await handleRevisionTool(client, 'restore_revision', { revisionId: revision.revisionId });

      expect(await client.getNoteContent(id)).toBe('<p>version one</p>');
      expect((await client.getNote(id)).title).toBe('Rev Original');
      expect((await client.getNoteRevisions(id)).length).toBe(before + 1);
    });
  });

  describe('search previews', () => {
    it('attaches plain-text previews', async () => {
      await note('Preview Subject', 'root', '<h2>Heading</h2><p>Unique zebra-quartz body text</p>');
      const result = json(
        await handleSearchTool(client, 'search_notes', {
          query: 'title:"Preview Subject"',
          content_preview_chars: 200,
        })
      );
      expect(result.results[0].contentPreview).toBe('Heading\nUnique zebra-quartz body text');
    });
  });

  describe('new ETAPI endpoints', () => {
    it('get_special_note week_first_day returns a day note', async () => {
      const day = json(
        await handleCalendarTool(client, 'get_special_note', {
          kind: 'week_first_day',
          date: '2026-10-15',
        })
      );
      expect(day.attributes.some((a: { name: string }) => a.name === 'dateNote')).toBe(true);
    });

    it('manage_system metrics returns database counts', async () => {
      const metrics = json(await handleSystemTool(client, 'manage_system', { action: 'metrics' }));
      expect(metrics.database.activeNotes).toBeGreaterThan(0);
    });

    it('write_note metadata can backdate the creation date', async () => {
      const id = await note('Backdated');
      await handleNoteTool(client, 'write_note', {
        noteId: id,
        mode: 'metadata',
        utcDateCreated: '2020-02-02 02:02:02.000Z',
      });
      expect((await client.getNote(id)).utcDateCreated).toBe('2020-02-02 02:02:02.000Z');
    });

    it('utcDateModified is applied, or cleanly rejected by Trilium <= 0.105', async () => {
      const id = await note('Backdated Modified');
      try {
        await handleNoteTool(client, 'write_note', {
          noteId: id,
          mode: 'metadata',
          utcDateModified: '2020-02-02 02:02:02.000Z',
        });
        expect((await client.getNote(id)).utcDateModified).toBe('2020-02-02 02:02:02.000Z');
      } catch (error) {
        expect(error).toMatchObject({ code: 'PROPERTY_NOT_ALLOWED' });
      }
    });

    it('get_note_history returns a bounded envelope', async () => {
      const history = json(await handleNoteTool(client, 'get_note_history', { limit: 3 }));
      expect(history.returned).toBeLessThanOrEqual(3);
      expect(history.total).toBeGreaterThanOrEqual(history.returned);
    });
  });
});
