/**
 * Behavior added in the prompts/tools audit: search shaping, tree branch
 * pairing, attribute replacement, export resources, reorder validation,
 * partial-failure reporting, restore ordering, calendar validation, and
 * annotations.
 */
import { describe, it, expect, vi } from 'vitest';
import type { TriliumClient } from '../../src/client/trilium.js';
import { TriliumClientError } from '../../src/client/trilium.js';
import {
  registerSearchTools,
  handleSearchTool,
  DEFAULT_SEARCH_LIMIT,
} from '../../src/tools/search.js';
import { registerAttributeTools, handleAttributeTool } from '../../src/tools/attributes.js';
import { registerSystemTools, handleSystemTool, MAX_EXPORT_BYTES } from '../../src/tools/system.js';
import { registerOrganizationTools, handleOrganizationTool } from '../../src/tools/organization.js';
import { registerRevisionTools, handleRevisionTool } from '../../src/tools/revisions.js';
import {
  registerCalendarTools,
  handleCalendarTool,
  validatePeriod,
} from '../../src/tools/calendar.js';

type Fn = ReturnType<typeof vi.fn>;

function client(overrides: Record<string, unknown> = {}): TriliumClient {
  return {
    getNote: vi.fn(),
    getNoteUrl: vi.fn().mockResolvedValue('http://t/#root/x'),
    getNoteContent: vi.fn(),
    searchNotes: vi.fn(),
    createAttribute: vi.fn(),
    updateAttribute: vi.fn(),
    deleteAttribute: vi.fn(),
    exportNote: vi.fn(),
    createRevision: vi.fn(),
    getBranch: vi.fn(),
    createBranch: vi.fn(),
    updateBranch: vi.fn(),
    deleteBranch: vi.fn(),
    refreshNoteOrdering: vi.fn(),
    getRevision: vi.fn(),
    getRevisionContent: vi.fn(),
    getRevisionContentBinary: vi.fn(),
    updateNote: vi.fn(),
    updateNoteContent: vi.fn(),
    updateNoteContentBinary: vi.fn(),
    getDayNote: vi.fn().mockResolvedValue({ noteId: 'day' }),
    getWeekNote: vi.fn().mockResolvedValue({ noteId: 'week' }),
    getMonthNote: vi.fn().mockResolvedValue({ noteId: 'month' }),
    ...overrides,
  } as unknown as TriliumClient;
}

const json = (r: { content: Array<{ type: string; text?: string }> } | null, i = 0) =>
  JSON.parse((r?.content[i] as { text: string }).text);

function fullNote(id: string) {
  return {
    noteId: id,
    title: `Note ${id}`,
    type: 'text',
    mime: 'text/html',
    isProtected: false,
    blobId: 'blob1',
    attributes: [
      {
        attributeId: 'a1',
        noteId: id,
        type: 'label',
        name: 'tag',
        value: 'x',
        position: 10,
        isInheritable: false,
        utcDateModified: 'u',
      },
    ],
    parentNoteIds: ['root'],
    childNoteIds: ['c1', 'c2'],
    parentBranchIds: ['root_' + id],
    childBranchIds: [id + '_c1', id + '_c2'],
    dateCreated: 'd',
    dateModified: 'm',
    utcDateCreated: 'uc',
    utcDateModified: 'um',
  };
}

// ============================================================================
// search_notes
// ============================================================================

describe('search_notes result shaping', () => {
  it('defaults limit to 50, over-fetches one, and reports truncation', async () => {
    const results = Array.from({ length: DEFAULT_SEARCH_LIMIT + 1 }, (_, i) => fullNote(`n${i}`));
    const c = client();
    (c.searchNotes as Fn).mockResolvedValue({ results });
    const out = json(await handleSearchTool(c, 'search_notes', { query: '#tag' }));
    expect((c.searchNotes as Fn).mock.calls[0][0].limit).toBe(DEFAULT_SEARCH_LIMIT + 1);
    expect(out.results).toHaveLength(DEFAULT_SEARCH_LIMIT);
    expect(out.returned).toBe(DEFAULT_SEARCH_LIMIT);
    expect(out.truncated).toBe(true);
    expect(out.note).toContain('raise limit');
  });

  it('never over-fetches past the 10000 ceiling', async () => {
    const c = client();
    (c.searchNotes as Fn).mockResolvedValue({ results: [] });
    await handleSearchTool(c, 'search_notes', { query: '#tag', limit: 10000 });
    expect((c.searchNotes as Fn).mock.calls[0][0].limit).toBe(10000);
  });

  it('trims heavy fields by default', async () => {
    const c = client();
    (c.searchNotes as Fn).mockResolvedValue({ results: [fullNote('n1')] });
    const out = json(await handleSearchTool(c, 'search_notes', { query: '#tag', limit: 5 }));
    expect(out.truncated).toBe(false);
    expect(out.results[0]).toEqual({
      noteId: 'n1',
      title: 'Note n1',
      type: 'text',
      mime: 'text/html',
      dateModified: 'm',
      parentNoteIds: ['root'],
      attributes: [{ type: 'label', name: 'tag', value: 'x' }],
    });
  });

  it('returns full metadata with verbose:true', async () => {
    const c = client();
    (c.searchNotes as Fn).mockResolvedValue({ results: [fullNote('n1')] });
    const out = json(await handleSearchTool(c, 'search_notes', { query: '#tag', verbose: true }));
    expect(out.results[0].childBranchIds).toEqual(['n1_c1', 'n1_c2']);
    expect(out.results[0].utcDateModified).toBe('um');
  });

  it('marks a result whose preview could not be loaded', async () => {
    const c = client();
    (c.searchNotes as Fn).mockResolvedValue({ results: [fullNote('n1'), fullNote('n2')] });
    (c.getNoteContent as Fn).mockImplementation(async (id: string) => {
      if (id === 'n1') throw new Error('gone');
      return '<p>Hello</p>';
    });
    const out = json(
      await handleSearchTool(c, 'search_notes', { query: '#tag', content_preview_chars: 10 })
    );
    expect(out.results[0].contentPreviewError).toBe(true);
    expect(out.results[0].contentPreview).toBeUndefined();
    expect(out.results[1].contentPreview).toBe('Hello');
    expect(out.results[1].contentPreviewError).toBeUndefined();
  });

  it('compacts the id: lookup result too, keeping previews', async () => {
    const c = client();
    (c.getNote as Fn).mockResolvedValue(fullNote('abc123def456'));
    (c.getNoteContent as Fn).mockResolvedValue('<p>Hello</p>');
    const out = json(
      await handleSearchTool(c, 'search_notes', {
        query: 'id:abc123def456',
        content_preview_chars: 10,
      })
    );
    expect(out.results[0].childNoteIds).toBeUndefined();
    expect(out.results[0].contentPreview).toBe('Hello');
  });

  it('rejects path-like ancestorNoteId values', async () => {
    await expect(
      handleSearchTool(client(), 'search_notes', { query: 'x', ancestorNoteId: '../etc' })
    ).rejects.toThrow();
  });

  it('describes OR as content-only and points titles at title:', () => {
    const [search] = registerSearchTools();
    expect(search.description).toContain('content only');
    expect(search.description).toContain('title:a or title:b');
    const props = search.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.limit.description).toContain('default 50');
  });
});

// ============================================================================
// get_note_tree
// ============================================================================

describe('get_note_tree branch pairing', () => {
  it('pairs each visible child with its own branch after filtering system notes', async () => {
    const notes: Record<string, { childNoteIds: string[]; childBranchIds: string[] }> = {
      root: {
        childNoteIds: ['_hidden', 'a', '_lbRoot', 'b'],
        childBranchIds: ['root__hidden', 'root_a', 'root__lbRoot', 'root_b'],
      },
      a: { childNoteIds: [], childBranchIds: [] },
      b: { childNoteIds: [], childBranchIds: [] },
    };
    const c = client({
      getNote: vi.fn(async (id: string) => ({ noteId: id, title: id, type: 'text', ...notes[id] })),
    });
    const tree = json(await handleSearchTool(c, 'get_note_tree', { noteId: 'root' }));
    expect(tree.childBranchIds).toEqual(['root_a', 'root_b']);
    expect(
      tree.children.map((n: { noteId: string; branchId: string }) => [n.noteId, n.branchId])
    ).toEqual([
      ['a', 'root_a'],
      ['b', 'root_b'],
    ]);
    expect(tree.systemChildrenSkipped).toBe(2);
  });

  it('bounds concurrent getNote calls', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `c${i}`);
    let inFlight = 0;
    let peak = 0;
    const c = client({
      getNote: vi.fn(async (id: string) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return id === 'root'
          ? { noteId: id, childNoteIds: ids, childBranchIds: ids.map((x) => `root_${x}`) }
          : { noteId: id, childNoteIds: [], childBranchIds: [] };
      }),
    });
    await handleSearchTool(c, 'get_note_tree', { noteId: 'root' });
    expect(peak).toBeLessThanOrEqual(5);
  });
});

// ============================================================================
// set_attribute
// ============================================================================

describe('set_attribute replacement', () => {
  const rel = {
    attributeId: 'r1',
    noteId: 'n1',
    type: 'relation',
    name: 'template',
    value: 'old',
    position: 30,
    isInheritable: false,
  };

  it('recreates a relation whose target changes (PATCH cannot change it)', async () => {
    const c = client();
    (c.getNote as Fn).mockResolvedValue({ noteId: 'n1', attributes: [rel] });
    (c.createAttribute as Fn).mockResolvedValue({ ...rel, attributeId: 'r2', value: 'new' });
    const out = json(
      await handleAttributeTool(c, 'set_attribute', {
        noteId: 'n1',
        type: 'relation',
        name: 'template',
        value: 'new',
      })
    );
    expect(c.updateAttribute).not.toHaveBeenCalled();
    expect(c.createAttribute).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'new', position: 30, isInheritable: false })
    );
    expect(c.deleteAttribute).toHaveBeenCalledWith('r1');
    // Created before deleting, so a failure never loses the attribute.
    expect((c.createAttribute as Fn).mock.invocationCallOrder[0]).toBeLessThan(
      (c.deleteAttribute as Fn).mock.invocationCallOrder[0]
    );
    expect(out).toMatchObject({ replaced: true, oldAttributeId: 'r1', attributeId: 'r2' });
  });

  it('recreates a label when isInheritable changes', async () => {
    const label = { ...rel, attributeId: 'l1', type: 'label', name: 'color', value: 'red' };
    const c = client();
    (c.getNote as Fn).mockResolvedValue({ noteId: 'n1', attributes: [label] });
    (c.createAttribute as Fn).mockResolvedValue({ ...label, attributeId: 'l2' });
    const out = json(
      await handleAttributeTool(c, 'set_attribute', {
        noteId: 'n1',
        type: 'label',
        name: 'color',
        value: 'red',
        isInheritable: true,
      })
    );
    expect(c.createAttribute).toHaveBeenCalledWith(
      expect.objectContaining({ isInheritable: true })
    );
    expect(out.replaced).toBe(true);
  });

  it('patches only position for a relation with an unchanged target', async () => {
    const c = client();
    (c.getNote as Fn).mockResolvedValue({ noteId: 'n1', attributes: [rel] });
    (c.updateAttribute as Fn).mockResolvedValue(rel);
    await handleAttributeTool(c, 'set_attribute', {
      noteId: 'n1',
      type: 'relation',
      name: 'template',
      value: 'old',
      position: 5,
    });
    expect(c.updateAttribute).toHaveBeenCalledWith('r1', { position: 5 });
    expect(c.createAttribute).not.toHaveBeenCalled();
  });

  it('reports both IDs if deleting the old attribute fails', async () => {
    const c = client();
    (c.getNote as Fn).mockResolvedValue({ noteId: 'n1', attributes: [rel] });
    (c.createAttribute as Fn).mockResolvedValue({ ...rel, attributeId: 'r2' });
    (c.deleteAttribute as Fn).mockRejectedValue(new Error('boom'));
    await expect(
      handleAttributeTool(c, 'set_attribute', {
        noteId: 'n1',
        type: 'relation',
        name: 'template',
        value: 'new',
      })
    ).rejects.toThrow(/r2.*r1/);
  });

  it('ignores attributes owned by another note when listing and upserting', async () => {
    const inherited = { ...rel, attributeId: 'x9', noteId: 'parent' };
    const c = client();
    (c.getNote as Fn).mockResolvedValue({ noteId: 'n1', attributes: [inherited] });
    (c.createAttribute as Fn).mockResolvedValue({ attributeId: 'new' });
    await handleAttributeTool(c, 'set_attribute', {
      noteId: 'n1',
      type: 'relation',
      name: 'template',
      value: 'v',
    });
    expect(c.deleteAttribute).not.toHaveBeenCalled();
    const listed = json(await handleAttributeTool(c, 'get_attributes', { noteId: 'n1' }));
    expect(listed.relations).toHaveLength(0);
  });

  it('documents own-only listing and the replace behavior', () => {
    const [get, set] = registerAttributeTools();
    expect(get.description).toContain('inherited');
    expect(set.description).toContain('replaced:true');
  });
});

// ============================================================================
// manage_system / create_revision
// ============================================================================

describe('manage_system export', () => {
  it('returns the ZIP as an embedded resource plus a text summary', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 255]);
    const c = client();
    (c.exportNote as Fn).mockResolvedValue(Buffer.from(bytes));
    const r = await handleSystemTool(c, 'manage_system', { action: 'export', noteId: 'n1' });
    expect(r?.content).toHaveLength(2);
    const summary = json(r);
    expect(summary).toMatchObject({ action: 'export', noteId: 'n1', sizeBytes: 5 });
    expect(summary.base64Data).toBeUndefined();
    const resource = r?.content[1] as {
      type: string;
      resource: { uri: string; mimeType: string; blob: string };
    };
    expect(resource.type).toBe('resource');
    expect(resource.resource.mimeType).toBe('application/zip');
    expect(Buffer.from(resource.resource.blob, 'base64')).toEqual(Buffer.from(bytes));
  });

  it('accepts the spec-supported "share" format', async () => {
    const c = client();
    (c.exportNote as Fn).mockResolvedValue(Buffer.alloc(1));
    await handleSystemTool(c, 'manage_system', { action: 'export', noteId: 'n1', format: 'share' });
    expect(c.exportNote).toHaveBeenCalledWith('n1', 'share', MAX_EXPORT_BYTES);
  });

  it('refuses oversized exports with an actionable error', async () => {
    const c = client();
    (c.exportNote as Fn).mockResolvedValue(Buffer.alloc(MAX_EXPORT_BYTES + 1));
    await expect(
      handleSystemTool(c, 'manage_system', { action: 'export', noteId: 'root' })
    ).rejects.toThrow(/smaller subtree/);
  });

  it('describes export honestly and flags read-only actions', () => {
    const [, manage] = registerSystemTools();
    expect(manage.description).toContain('cannot read the ZIP');
    expect(manage.description).toContain('"app_info" (read-only)');
    expect(manage.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(manage.annotations?.title).toContain('metrics');
  });
});

describe('create_revision', () => {
  it('has no format param and returns JSON with noteId and url', async () => {
    const [createRevision] = registerSystemTools();
    expect(
      (createRevision.inputSchema.properties as Record<string, unknown>).format
    ).toBeUndefined();
    const c = client();
    const out = json(await handleSystemTool(c, 'create_revision', { noteId: 'n1', format: 'x' }));
    expect(c.createRevision).toHaveBeenCalledWith('n1');
    expect(out).toMatchObject({ success: true, noteId: 'n1', url: 'http://t/#root/x' });
  });
});

// ============================================================================
// organize_note
// ============================================================================

describe('organize_note reorder validation', () => {
  it('rejects branches that are not children of parentNoteId before updating any', async () => {
    const c = client();
    (c.getBranch as Fn).mockImplementation(async (id: string) => ({
      branchId: id,
      parentNoteId: id === 'b2' ? 'elsewhere' : 'p1',
    }));
    await expect(
      handleOrganizationTool(c, 'organize_note', {
        action: 'reorder',
        parentNoteId: 'p1',
        notePositions: [
          { branchId: 'b1', notePosition: 10 },
          { branchId: 'b2', notePosition: 20 },
        ],
      })
    ).rejects.toThrow(/b2 \(parent 'elsewhere'\)/);
    expect(c.updateBranch).not.toHaveBeenCalled();
  });

  it('reports which branches were updated when one fails', async () => {
    const c = client();
    (c.getBranch as Fn).mockImplementation(async (id: string) => ({
      branchId: id,
      parentNoteId: 'p1',
    }));
    (c.updateBranch as Fn)
      .mockResolvedValueOnce({ branchId: 'b1' })
      .mockRejectedValueOnce(new Error('nope'));
    await expect(
      handleOrganizationTool(c, 'organize_note', {
        action: 'reorder',
        parentNoteId: 'p1',
        notePositions: [
          { branchId: 'b1', notePosition: 10 },
          { branchId: 'b2', notePosition: 20 },
        ],
      })
    ).rejects.toThrow(/failed at branch 'b2'.*Already updated: b1/);
  });
});

describe('organize_note move partial failure', () => {
  it('says the note is now in both places, with branch ids', async () => {
    const c = client();
    (c.getNote as Fn).mockResolvedValue({ noteId: 'n1', parentBranchIds: ['old_n1'] });
    (c.getBranch as Fn).mockResolvedValue({ branchId: 'old_n1', parentNoteId: 'old' });
    (c.createBranch as Fn).mockResolvedValue({ branchId: 'new_n1', parentNoteId: 'new' });
    (c.deleteBranch as Fn).mockRejectedValue(new Error('locked'));
    await expect(
      handleOrganizationTool(c, 'organize_note', {
        action: 'move',
        noteId: 'n1',
        newParentNoteId: 'new',
      })
    ).rejects.toThrow(/both places.*new_n1|new_n1.*both places/s);
  });

  it('describes clone vs move parent params', () => {
    const [tool] = registerOrganizationTools();
    const props = tool.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.newParentNoteId.description).toContain('parentNoteId');
  });

  it('describes moving onto a current parent as it behaves (removes the other placement)', async () => {
    const [tool] = registerOrganizationTools();
    expect(tool.description).not.toContain('no-op');
    expect(tool.description).toContain('REMOVED');
    // Behavior the description promises: parents [a, z], move to z => a is unlinked.
    const c = client();
    (c.getNote as Fn).mockResolvedValue({ noteId: 'n1', parentBranchIds: ['b_a', 'b_z'] });
    (c.getBranch as Fn).mockImplementation(async (id: string) => ({
      branchId: id,
      parentNoteId: id.slice(2),
    }));
    (c.createBranch as Fn).mockResolvedValue({ branchId: 'b_z', parentNoteId: 'z' });
    await handleOrganizationTool(c, 'organize_note', {
      action: 'move',
      noteId: 'n1',
      newParentNoteId: 'z',
    });
    expect(c.deleteBranch).toHaveBeenCalledWith('b_a');
  });
});

// ============================================================================
// restore_revision ordering
// ============================================================================

describe('restore_revision ordering', () => {
  it('reads the revision body before changing the note', async () => {
    const c = client();
    (c.getRevision as Fn).mockResolvedValue({
      revisionId: 'r1',
      noteId: 'n1',
      type: 'code',
      mime: 'text/x-python',
      title: 'Old',
      isProtected: false,
    });
    (c.getNote as Fn).mockResolvedValue({
      noteId: 'n1',
      type: 'text',
      mime: 'text/html',
      title: 'New',
      isProtected: false,
    });
    (c.getRevisionContent as Fn).mockRejectedValue(new Error('blob gone'));
    await expect(handleRevisionTool(c, 'restore_revision', { revisionId: 'r1' })).rejects.toThrow(
      'blob gone'
    );
    expect(c.createRevision).not.toHaveBeenCalled();
    expect(c.updateNote).not.toHaveBeenCalled();
    expect(c.updateNoteContent).not.toHaveBeenCalled();
  });
});

// ============================================================================
// get_special_note date validation
// ============================================================================

describe('get_special_note date validation', () => {
  it.each([
    ['day', '2024-13-45'],
    ['day', '2023-02-29'],
    ['inbox', '2024-04-31'],
    ['month', '2024-00'],
    ['month', '2024-13'],
    ['week', '2021-W53'],
    ['week', '2024-W00'],
  ] as const)('rejects %s %s', async (kind, date) => {
    await expect(handleCalendarTool(client(), 'get_special_note', { kind, date })).rejects.toThrow(
      /Invalid date/
    );
  });

  it.each([
    ['day', '2024-02-29'],
    ['month', '2024-12'],
    ['week', '2020-W53'],
    ['week', '2026-W01'],
  ] as const)('accepts %s %s', async (kind, date) => {
    expect(validatePeriod(kind, date)).toBeNull();
    await handleCalendarTool(client(), 'get_special_note', { kind, date });
  });

  it('error message names the actual problem', () => {
    expect(validatePeriod('day', '2024-02-30')).toContain('out of range');
  });

  it('annotations: may create but never destroys, idempotent', () => {
    const [tool] = registerCalendarTools();
    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const props = tool.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.date.description).toContain('timezone');
  });
});

// ============================================================================
// annotations across the audited tools
// ============================================================================

describe('annotations', () => {
  it('every audited tool sets openWorldHint:false explicitly', () => {
    for (const t of [
      ...registerSearchTools(),
      ...registerAttributeTools(),
      ...registerSystemTools(),
      ...registerOrganizationTools(),
      ...registerRevisionTools(),
      ...registerCalendarTools(),
    ]) {
      expect(t.annotations?.openWorldHint, t.name).toBe(false);
    }
  });

  it('organize_note stays destructive', () => {
    expect(registerOrganizationTools()[0].annotations?.destructiveHint).toBe(true);
  });
});

describe('errors from TriliumClientError carry through', () => {
  it('export size error is a TriliumClientError with a code', async () => {
    const c = client();
    (c.exportNote as Fn).mockResolvedValue(Buffer.alloc(MAX_EXPORT_BYTES + 1));
    const err = await handleSystemTool(c, 'manage_system', {
      action: 'export',
      noteId: 'n1',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TriliumClientError);
    expect(err.code).toBe('EXPORT_TOO_LARGE');
  });
});
