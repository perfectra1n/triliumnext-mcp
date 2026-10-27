import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  handleSearchTool,
  configureSearch,
  FAST_FIRST_MIN_RESULTS,
} from '../../src/tools/search.js';
import { TriliumClientError, type TriliumClient } from '../../src/client/trilium.js';
import type { ToolContext } from '../../src/tools/context.js';

const notes = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    noteId: `n${i}`,
    title: `Note ${i}`,
    type: 'text',
    isProtected: false,
    attributes: [],
  }));

function mockClient(...responses: unknown[]) {
  const searchNotes = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) searchNotes.mockRejectedValueOnce(r);
    else searchNotes.mockResolvedValueOnce(r);
  }
  const client = { searchNotes, getNote: vi.fn(), getNoteContent: vi.fn() };
  return { client: client as unknown as TriliumClient, searchNotes };
}

async function run(client: TriliumClient, args: Record<string, unknown>, ctx: ToolContext = {}) {
  const result = await handleSearchTool(client, 'search_notes', args, ctx);
  return JSON.parse((result?.content[0] as { text: string }).text);
}

describe('search_notes strategy', () => {
  afterEach(() => configureSearch({}));

  it('auto: returns the fast title/label matches when there are enough', async () => {
    const { client, searchNotes } = mockClient({ results: notes(FAST_FIRST_MIN_RESULTS) });
    const out = await run(client, { query: 'afi' });

    expect(searchNotes).toHaveBeenCalledTimes(1);
    expect(searchNotes.mock.calls[0][0]).toMatchObject({ search: 'afi', fastSearch: true });
    expect(out.searchMode).toBe('fast');
    expect(out.note).toContain('strategy:"full"');
    expect(out.results).toHaveLength(FAST_FIRST_MIN_RESULTS);
  });

  it('auto: searches note bodies when the fast pass finds too few, and reports it', async () => {
    const { client, searchNotes } = mockClient({ results: notes(1) }, { results: notes(8) });
    const progress = vi.fn();
    const out = await run(client, { query: 'olafsson' }, { progress });

    expect(searchNotes).toHaveBeenCalledTimes(2);
    expect(searchNotes.mock.calls[1][0].fastSearch).toBeUndefined();
    expect(out.searchMode).toBeUndefined();
    expect(out.results).toHaveLength(8);
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('note bodies'));
  });

  it('auto: a smaller limit lowers the bar for the fast pass', async () => {
    const { client, searchNotes } = mockClient({ results: notes(1) });
    const out = await run(client, { query: 'afi', limit: 1 });
    expect(searchNotes).toHaveBeenCalledTimes(1);
    expect(out.searchMode).toBe('fast');
  });

  it('auto: falls back to the fast matches, marked partial, when Trilium is busy', async () => {
    const { client } = mockClient(
      { results: notes(2) },
      new TriliumClientError(503, 'TRILIUM_BUSY', 'Trilium is busy. Try again in about 20s.')
    );
    const out = await run(client, { query: 'afi' });

    expect(out.partial).toBe(true);
    expect(out.searchMode).toBe('fast');
    expect(out.results).toHaveLength(2);
    expect(out.note).toContain('Try again in about 20s');
  });

  it('auto: rethrows when the fast pass found nothing either', async () => {
    const { client } = mockClient(
      { results: [] },
      new TriliumClientError(504, 'TRILIUM_TIMEOUT', 'timed out')
    );
    await expect(handleSearchTool(client, 'search_notes', { query: 'afi' })).rejects.toMatchObject({
      code: 'TRILIUM_TIMEOUT',
    });
  });

  it('auto: does not swallow unrelated errors', async () => {
    const { client } = mockClient(
      { results: notes(2) },
      new TriliumClientError(401, 'ETAPI_TOKEN_INVALID', 'bad token')
    );
    await expect(handleSearchTool(client, 'search_notes', { query: 'afi' })).rejects.toMatchObject({
      code: 'ETAPI_TOKEN_INVALID',
    });
  });

  it('full: one body search, no fast pass', async () => {
    const { client, searchNotes } = mockClient({ results: notes(1) });
    await run(client, { query: 'afi', strategy: 'full' });
    expect(searchNotes).toHaveBeenCalledTimes(1);
    expect(searchNotes.mock.calls[0][0].fastSearch).toBeUndefined();
  });

  it('fast: titles and labels only, with no fuzzy retry into note bodies', async () => {
    const { client, searchNotes } = mockClient({ results: [] });
    const out = await run(client, { query: 'two words', strategy: 'fast' });
    expect(searchNotes).toHaveBeenCalledTimes(1);
    expect(searchNotes.mock.calls[0][0].fastSearch).toBe(true);
    expect(out.searchMode).toBe('fast');
  });

  it('runs Trilium syntax as written', async () => {
    const { client, searchNotes } = mockClient({ results: [] });
    await run(client, { query: '#project' });
    expect(searchNotes).toHaveBeenCalledTimes(1);
    expect(searchNotes.mock.calls[0][0]).toMatchObject({ search: '#project' });
    expect(searchNotes.mock.calls[0][0].fastSearch).toBeUndefined();
  });

  it('lets an explicit fastSearch flag win', async () => {
    const { client, searchNotes } = mockClient({ results: [] });
    await run(client, { query: 'afi', fastSearch: false });
    expect(searchNotes).toHaveBeenCalledTimes(1);
    expect(searchNotes.mock.calls[0][0].fastSearch).toBe(false);
  });

  it('honours the configured default strategy', async () => {
    configureSearch({ defaultStrategy: 'full' });
    const { client, searchNotes } = mockClient({ results: [] });
    await run(client, { query: 'afi' });
    expect(searchNotes).toHaveBeenCalledTimes(1);
    expect(searchNotes.mock.calls[0][0].fastSearch).toBeUndefined();
  });
});
