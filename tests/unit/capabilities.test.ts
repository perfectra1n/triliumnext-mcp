import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TriliumClient } from '../../src/client/trilium.js';
import { TriliumClientError } from '../../src/client/trilium.js';
import { handleNoteTool } from '../../src/tools/notes.js';
import { handleSearchTool, htmlToPreviewText } from '../../src/tools/search.js';
import { handleOrganizationTool, pickSourceBranch } from '../../src/tools/organization.js';
import { handleRevisionTool } from '../../src/tools/revisions.js';
import { handleCalendarTool } from '../../src/tools/calendar.js';
import { handleSystemTool } from '../../src/tools/system.js';
import { needsLinkIndexing, resolveNoteLinks } from '../../src/tools/noteLinks.js';
import type { Branch } from '../../src/types/etapi.js';

type Fn = ReturnType<typeof vi.fn>;

/** A tiny in-memory tree: root -> projects -> plan, plus a cloned note. */
const NOTES: Record<
  string,
  { noteId: string; title: string; type: string; parentNoteIds: string[] }
> = {
  root: { noteId: 'root', title: 'root', type: 'book', parentNoteIds: [] },
  projects: { noteId: 'projects', title: 'Projects', type: 'text', parentNoteIds: ['root'] },
  plan: { noteId: 'plan', title: 'Plan & Goals', type: 'text', parentNoteIds: ['projects'] },
  script: { noteId: 'script', title: 'Script', type: 'code', parentNoteIds: ['root'] },
};

function makeClient(overrides: Partial<Record<keyof TriliumClient, unknown>> = {}): TriliumClient {
  const getNote = vi.fn(async (id: string) => {
    const n = NOTES[id];
    if (!n) throw new TriliumClientError(404, 'NOTE_NOT_FOUND', `Note '${id}' not found.`);
    return { ...n, attributes: [], childNoteIds: [], parentBranchIds: [], childBranchIds: [] };
  });
  const getNotePath = vi.fn(async (id: string, via?: string) => {
    const segments = [id];
    let cursor = via ?? NOTES[id].parentNoteIds[0];
    while (cursor && cursor !== 'root') {
      segments.unshift(cursor);
      cursor = NOTES[cursor].parentNoteIds[0];
    }
    return ['root', ...segments].join('/');
  });
  return {
    getNote,
    getNotePath,
    getNoteUrl: vi.fn().mockResolvedValue('http://t/#root/x'),
    getNoteContent: vi.fn(),
    createNote: vi.fn(async (def: { parentNoteId: string }) => ({
      note: { noteId: 'new1' },
      branch: { branchId: 'b-new', parentNoteId: def.parentNoteId },
    })),
    updateNote: vi.fn(async (id: string) => ({ noteId: id, parentNoteIds: ['root'] })),
    updateNoteContent: vi.fn(),
    updateNoteContentBinary: vi.fn(),
    getNoteAttachments: vi.fn().mockResolvedValue([]),
    getNoteHistory: vi.fn(),
    searchNotes: vi.fn(),
    getBranch: vi.fn(),
    createBranch: vi.fn(),
    deleteBranch: vi.fn(),
    getRevision: vi.fn(),
    getRevisionContent: vi.fn(),
    getRevisionContentBinary: vi.fn(),
    createRevision: vi.fn(),
    getWeekFirstDayNote: vi.fn().mockResolvedValue({ noteId: 'day' }),
    getMetrics: vi.fn(),
    ...overrides,
  } as unknown as TriliumClient;
}

const text = (r: { content: Array<{ type: string; text?: string }> } | null, i = 0): string =>
  (r?.content[i] as { text: string }).text;

// ============================================================================
// organize_note move — branch selection safety
// ============================================================================

const branch = (branchId: string, parentNoteId: string): Branch =>
  ({ branchId, parentNoteId, noteId: 'n1' }) as Branch;

describe('pickSourceBranch', () => {
  it('returns the single placement for an ordinary move', () => {
    expect(pickSourceBranch('n1', [branch('b1', 'a')], 'z', undefined)?.branchId).toBe('b1');
  });

  it('returns nothing when moving onto the only current parent (no-op)', () => {
    expect(pickSourceBranch('n1', [branch('b1', 'a')], 'a', undefined)).toBeUndefined();
  });

  it('refuses to guess between clones', () => {
    expect(() =>
      pickSourceBranch('n1', [branch('b1', 'a'), branch('b2', 'b')], 'z', undefined)
    ).toThrow(/fromParentNoteId/);
  });

  it('uses fromParentNoteId to pick the clone', () => {
    const picked = pickSourceBranch('n1', [branch('b1', 'a'), branch('b2', 'b')], 'z', 'b');
    expect(picked?.branchId).toBe('b2');
  });

  it('collapses a clone onto the destination when it is already a parent', () => {
    const picked = pickSourceBranch('n1', [branch('b1', 'a'), branch('b2', 'z')], 'z', undefined);
    expect(picked?.branchId).toBe('b1');
  });

  it('rejects a fromParentNoteId that is not a parent', () => {
    expect(() => pickSourceBranch('n1', [branch('b1', 'a')], 'z', 'nope')).toThrow(/not a child/);
  });
});

describe('organize_note move', () => {
  it('never deletes the branch the upsert returned (move onto current parent)', async () => {
    // Regression: POST /branches returns the EXISTING branch here; deleting
    // parentBranchIds[0] afterwards used to delete the note's only placement.
    const client = makeClient({
      getNote: vi.fn().mockResolvedValue({ noteId: 'n1', parentBranchIds: ['b1'] }),
      getBranch: vi.fn().mockResolvedValue(branch('b1', 'a')),
      createBranch: vi.fn().mockResolvedValue(branch('b1', 'a')),
    });
    const result = await handleOrganizationTool(client, 'organize_note', {
      action: 'move',
      noteId: 'n1',
      newParentNoteId: 'a',
    });
    expect(client.deleteBranch).not.toHaveBeenCalled();
    expect(JSON.parse(text(result)).removedBranchId).toBeNull();
  });

  it('deletes the chosen clone and reports it', async () => {
    const client = makeClient({
      getNote: vi.fn().mockResolvedValue({ noteId: 'n1', parentBranchIds: ['b1', 'b2'] }),
      getBranch: vi.fn(async (id: string) => (id === 'b1' ? branch('b1', 'a') : branch('b2', 'b'))),
      createBranch: vi.fn().mockResolvedValue(branch('b3', 'z')),
    });
    const result = await handleOrganizationTool(client, 'organize_note', {
      action: 'move',
      noteId: 'n1',
      newParentNoteId: 'z',
      fromParentNoteId: 'b',
    });
    expect(client.deleteBranch).toHaveBeenCalledWith('b2');
    expect(JSON.parse(text(result))).toMatchObject({
      removedBranchId: 'b2',
      fromParentNoteId: 'b',
    });
  });

  it('fails before touching anything when a clone is ambiguous', async () => {
    const client = makeClient({
      getNote: vi.fn().mockResolvedValue({ noteId: 'n1', parentBranchIds: ['b1', 'b2'] }),
      getBranch: vi.fn(async (id: string) => (id === 'b1' ? branch('b1', 'a') : branch('b2', 'b'))),
    });
    await expect(
      handleOrganizationTool(client, 'organize_note', {
        action: 'move',
        noteId: 'n1',
        newParentNoteId: 'z',
      })
    ).rejects.toThrow(/cloned/);
    expect(client.createBranch).not.toHaveBeenCalled();
    expect(client.deleteBranch).not.toHaveBeenCalled();
  });
});

// ============================================================================
// note:ID link placeholders
// ============================================================================

describe('resolveNoteLinks', () => {
  it('builds a full reference link from the target path', async () => {
    const html = await resolveNoteLinks(
      makeClient(),
      '<p>see <a href="note:plan">the plan</a></p>'
    );
    expect(html).toBe(
      '<p>see <a class="reference-link" href="#root/projects/plan" ' +
        'data-note-path="root/projects/plan">the plan</a></p>'
    );
  });

  it('fills empty link text with the escaped target title', async () => {
    const html = await resolveNoteLinks(makeClient(), "<a href='note:plan'></a>");
    expect(html).toContain('>Plan &amp; Goals</a>');
  });

  it('rejects unknown targets instead of storing a dead link', async () => {
    await expect(resolveNoteLinks(makeClient(), '<a href="note:missing1">x</a>')).rejects.toThrow(
      /not found/
    );
  });

  it('leaves content without placeholders untouched (and makes no calls)', async () => {
    const client = makeClient();
    const html = '<a href="https://example.com">x</a>';
    expect(await resolveNoteLinks(client, html)).toBe(html);
    expect(client.getNote).not.toHaveBeenCalled();
  });
});

describe('needsLinkIndexing', () => {
  it('detects reference links and attachment images', () => {
    expect(needsLinkIndexing('<a href="#root/a/b">x</a>')).toBe(true);
    expect(needsLinkIndexing('<img src="api/attachments/a1/image/x.png">')).toBe(true);
    expect(needsLinkIndexing('<p>plain</p>')).toBe(false);
  });
});

describe('create_note link handling', () => {
  it('resolves markdown note: links and re-saves so Trilium indexes them', async () => {
    const client = makeClient();
    await handleNoteTool(client, 'create_note', {
      parentNoteId: 'projects',
      title: 'Child',
      type: 'text',
      format: 'markdown',
      content: 'Related: [the plan](note:plan)',
    });
    const created = (client.createNote as Fn).mock.calls[0][0].content as string;
    expect(created).toContain('class="reference-link"');
    expect(created).toContain('data-note-path="root/projects/plan"');
    expect(client.updateNoteContent).toHaveBeenCalledWith('new1', created);
  });

  it('a failed indexing re-save returns the created note with a warning', async () => {
    const client = makeClient({ updateNoteContent: vi.fn().mockRejectedValue(new Error('flaky')) });
    const result = await handleNoteTool(client, 'create_note', {
      parentNoteId: 'root',
      title: 'Linked',
      type: 'text',
      content: '<a href="note:plan">p</a>',
    });
    const payload = JSON.parse(text(result));
    expect(payload.note.noteId).toBe('new1');
    expect(payload.warning).toMatch(/Do NOT re-create/);
  });

  it('does not re-save plain notes', async () => {
    const client = makeClient();
    await handleNoteTool(client, 'create_note', {
      parentNoteId: 'root',
      title: 'Plain',
      type: 'text',
      content: '<p>hello</p>',
    });
    expect(client.updateNoteContent).not.toHaveBeenCalled();
  });

  it('restores utcDateModified after the indexing re-save', async () => {
    const client = makeClient();
    await handleNoteTool(client, 'create_note', {
      parentNoteId: 'root',
      title: 'Migrated',
      type: 'text',
      content: '<a href="note:plan">p</a>',
      utcDateModified: '2020-01-01 00:00:00.000Z',
    });
    expect((client.createNote as Fn).mock.calls[0][0].utcDateModified).toBe(
      '2020-01-01 00:00:00.000Z'
    );
    expect(client.updateNote).toHaveBeenCalledWith('new1', {
      utcDateModified: '2020-01-01 00:00:00.000Z',
    });
  });
});

describe('write_note link handling and dates', () => {
  it('resolves note: links on text notes', async () => {
    const client = makeClient();
    await handleNoteTool(client, 'write_note', {
      noteId: 'projects',
      mode: 'replace',
      content: '<a href="note:plan">p</a>',
    });
    expect((client.updateNoteContent as Fn).mock.calls[0][1]).toContain('reference-link');
  });

  it('edit mode resolves placeholders in new_string and verifies the resolved text', async () => {
    const stored: string[] = [];
    const client = makeClient({
      getNoteContent: vi.fn(async () => stored.at(-1) ?? '<p>TODO</p>'),
      updateNoteContent: vi.fn(async (_id: string, c: string) => void stored.push(c)),
    });
    await handleNoteTool(client, 'write_note', {
      noteId: 'projects',
      mode: 'edit',
      changes: [{ old_string: 'TODO', new_string: 'see <a href="note:plan">plan</a>' }],
    });
    expect(stored[0]).toContain('data-note-path="root/projects/plan"');
  });

  it('leaves note: strings alone in code notes', async () => {
    const client = makeClient();
    const code = 'const a = \'<a href="note:plan">p</a>\';';
    await handleNoteTool(client, 'write_note', {
      noteId: 'script',
      mode: 'replace',
      content: code,
    });
    expect((client.updateNoteContent as Fn).mock.calls[0][1]).toBe(code);
  });

  it('metadata mode patches date fields', async () => {
    const client = makeClient();
    await handleNoteTool(client, 'write_note', {
      noteId: 'plan',
      mode: 'metadata',
      utcDateModified: '2021-05-05 10:00:00.000Z',
    });
    expect(client.updateNote).toHaveBeenCalledWith('plan', {
      utcDateModified: '2021-05-05 10:00:00.000Z',
    });
  });

  it('rejects date fields outside metadata mode', async () => {
    await expect(
      handleNoteTool(makeClient(), 'write_note', {
        noteId: 'plan',
        mode: 'replace',
        content: 'x',
        dateCreated: '2021-05-05 10:00:00.000+0000',
      })
    ).rejects.toThrow(/metadata fields/);
  });
});

// ============================================================================
// get_note context: paths + backlinks; history limit
// ============================================================================

describe('get_note include_path / include_backlinks', () => {
  it('returns breadcrumbs for each placement', async () => {
    const result = await handleNoteTool(makeClient(), 'get_note', {
      noteId: 'plan',
      include_content: false,
      include_path: true,
    });
    expect(JSON.parse(text(result)).paths).toEqual([
      { path: 'root/projects/plan', breadcrumb: 'root > Projects > Plan & Goals' },
    ]);
  });

  it('returns backlinks from a content search, excluding the note itself', async () => {
    const client = makeClient({
      searchNotes: vi.fn().mockResolvedValue({
        results: [
          { noteId: 'plan', title: 'Plan & Goals' },
          { noteId: 'projects', title: 'Projects' },
        ],
      }),
    });
    const result = await handleNoteTool(client, 'get_note', {
      noteId: 'plan',
      include_content: false,
      include_backlinks: true,
    });
    expect((client.searchNotes as Fn).mock.calls[0][0].search).toBe('note.content *=* "plan"');
    expect(JSON.parse(text(result)).backlinks).toEqual([{ noteId: 'projects', title: 'Projects' }]);
  });

  it('adds nothing (and makes no extra calls) by default', async () => {
    const client = makeClient();
    const result = await handleNoteTool(client, 'get_note', {
      noteId: 'plan',
      include_content: false,
    });
    const meta = JSON.parse(text(result));
    expect(meta.paths).toBeUndefined();
    expect(meta.backlinks).toBeUndefined();
    expect(client.searchNotes).not.toHaveBeenCalled();
  });
});

describe('get_note_history limit', () => {
  it('bounds the change list and reports truncation', async () => {
    const changes = Array.from({ length: 5 }, (_, i) => ({ noteId: `n${i}` }));
    const client = makeClient({ getNoteHistory: vi.fn().mockResolvedValue(changes) });
    const result = await handleNoteTool(client, 'get_note_history', { limit: 2 });
    expect(JSON.parse(text(result))).toEqual({
      changes: changes.slice(0, 2),
      total: 5,
      returned: 2,
      truncated: true,
    });
  });
});

// ============================================================================
// search_notes content previews
// ============================================================================

describe('search_notes content_preview_chars', () => {
  it('attaches stripped, truncated previews and skips binary notes', async () => {
    const client = makeClient({
      searchNotes: vi.fn().mockResolvedValue({
        results: [
          { noteId: 'a', type: 'text' },
          { noteId: 'img', type: 'image' },
        ],
      }),
      getNoteContent: vi.fn().mockResolvedValue('<h1>Title</h1><p>Body &amp; more text</p>'),
    });
    const result = await handleSearchTool(client, 'search_notes', {
      query: '#x',
      content_preview_chars: 12,
    });
    const [a, img] = JSON.parse(text(result)).results;
    expect(a.contentPreview).toBe('Title\nBody &…');
    expect(img.contentPreview).toBeUndefined();
    expect(client.getNoteContent).toHaveBeenCalledTimes(1);
  });

  it('a failing preview never fails the search', async () => {
    const client = makeClient({
      searchNotes: vi.fn().mockResolvedValue({ results: [{ noteId: 'a', type: 'text' }] }),
      getNoteContent: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const result = await handleSearchTool(client, 'search_notes', {
      query: '#x',
      content_preview_chars: 50,
    });
    expect(JSON.parse(text(result)).results[0].contentPreview).toBeUndefined();
  });

  it('htmlToPreviewText drops scripts and decodes entities', () => {
    expect(htmlToPreviewText('<script>x()</script><p>a&lt;b&nbsp;c</p>')).toBe('a<b c');
  });
});

// ============================================================================
// restore_revision
// ============================================================================

describe('restore_revision', () => {
  const revision = {
    revisionId: 'r1',
    noteId: 'plan',
    type: 'text',
    mime: 'text/html',
    title: 'Old Plan',
    isProtected: false,
    dateLastEdited: '2024-01-01 00:00:00.000+0000',
  };

  it('snapshots current state, restores title and content', async () => {
    const client = makeClient({
      getNote: vi.fn().mockResolvedValue({
        noteId: 'plan',
        type: 'text',
        mime: 'text/html',
        title: 'Plan',
        isProtected: false,
      }),
      getRevision: vi.fn().mockResolvedValue(revision),
      getRevisionContent: vi.fn().mockResolvedValue('<p>old</p>'),
    });
    const result = await handleRevisionTool(client, 'restore_revision', { revisionId: 'r1' });
    expect(client.createRevision).toHaveBeenCalledWith('plan');
    expect(client.updateNote).toHaveBeenCalledWith('plan', { title: 'Old Plan' });
    expect(client.updateNoteContent).toHaveBeenCalledWith('plan', '<p>old</p>');
    expect(JSON.parse(text(result))).toMatchObject({ success: true, restoredRevisionId: 'r1' });
    // The snapshot must happen before anything is overwritten.
    const snapshotOrder = (client.createRevision as Fn).mock.invocationCallOrder[0];
    expect(snapshotOrder).toBeLessThan(
      (client.updateNoteContent as Fn).mock.invocationCallOrder[0]
    );
  });

  it('restores binary notes byte-for-byte', async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const client = makeClient({
      getNote: vi
        .fn()
        .mockResolvedValue({ noteId: 'img', type: 'image', mime: 'image/png', title: 'x' }),
      getRevision: vi.fn().mockResolvedValue({
        ...revision,
        noteId: 'img',
        type: 'image',
        mime: 'image/png',
        title: 'x',
      }),
      getRevisionContentBinary: vi.fn().mockResolvedValue(bytes),
    });
    await handleRevisionTool(client, 'restore_revision', {
      revisionId: 'r1',
      snapshot_current: false,
    });
    expect(client.createRevision).not.toHaveBeenCalled();
    expect(client.updateNoteContentBinary).toHaveBeenCalledWith('img', bytes);
    expect(client.updateNoteContent).not.toHaveBeenCalled();
  });

  it('refuses protected notes before writing anything', async () => {
    const client = makeClient({
      getNote: vi.fn().mockResolvedValue({ noteId: 'plan', isProtected: true }),
      getRevision: vi.fn().mockResolvedValue(revision),
    });
    await expect(
      handleRevisionTool(client, 'restore_revision', { revisionId: 'r1' })
    ).rejects.toMatchObject({ code: 'NOTE_IS_PROTECTED' });
    expect(client.createRevision).not.toHaveBeenCalled();
  });
});

// ============================================================================
// New upstream endpoints
// ============================================================================

describe('get_special_note kind="week_first_day"', () => {
  it('calls the week-first-day endpoint with the given date', async () => {
    const client = makeClient();
    await handleCalendarTool(client, 'get_special_note', {
      kind: 'week_first_day',
      date: '2026-10-15',
    });
    expect(client.getWeekFirstDayNote).toHaveBeenCalledWith('2026-10-15');
  });

  it('validates the date as YYYY-MM-DD', async () => {
    await expect(
      handleCalendarTool(makeClient(), 'get_special_note', {
        kind: 'week_first_day',
        date: '2026-W03',
      })
    ).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe('manage_system action="metrics"', () => {
  let client: TriliumClient;
  beforeEach(() => {
    client = makeClient({
      getMetrics: vi.fn().mockResolvedValue({ database: { activeNotes: 3 } }),
    });
  });

  it('returns the JSON metrics', async () => {
    const result = await handleSystemTool(client, 'manage_system', { action: 'metrics' });
    expect(JSON.parse(text(result))).toEqual({ database: { activeNotes: 3 } });
  });

  it('explains a 404 from older Trilium versions', async () => {
    (client.getMetrics as Fn).mockRejectedValue(new TriliumClientError(404, 'NOT_FOUND', 'nope'));
    await expect(
      handleSystemTool(client, 'manage_system', { action: 'metrics' })
    ).rejects.toMatchObject({ code: 'METRICS_UNSUPPORTED' });
  });
});
