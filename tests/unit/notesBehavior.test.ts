import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  configureNoteTools,
  handleNoteTool,
  substituteAttachmentPlaceholders,
} from '../../src/tools/notes.js';
import { configureContentInput, getContentInputPolicy } from '../../src/tools/contentInput.js';
import { TriliumClientError, type TriliumClient } from '../../src/client/trilium.js';
import type { Attachment } from '../../src/types/etapi.js';

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString(
  'base64'
);

function mockClient(overrides: Record<string, unknown> = {}): TriliumClient {
  return {
    createNote: vi.fn().mockResolvedValue({
      note: { noteId: 'new1', title: 'T' },
      branch: { branchId: 'b1', parentNoteId: 'root' },
    }),
    getNote: vi
      .fn()
      .mockResolvedValue({ noteId: 'n1', title: 'T', type: 'text', mime: 'text/html' }),
    getNoteUrl: vi.fn().mockResolvedValue('http://t/#root/n1'),
    getNotePath: vi.fn().mockResolvedValue('root/n1'),
    getNoteContent: vi.fn().mockResolvedValue(''),
    updateNote: vi.fn(),
    updateNoteContent: vi.fn(),
    updateNoteContentBinary: vi.fn(),
    getNoteAttachments: vi.fn().mockResolvedValue([]),
    getAttachmentContentAsBase64: vi.fn().mockResolvedValue('aW1n'),
    createAttachment: vi.fn().mockImplementation(async (def: { title: string }) => ({
      attachmentId: `att_${def.title.length}`,
      title: def.title,
    })),
    updateAttachmentContentBinary: vi.fn(),
    ...overrides,
  } as unknown as TriliumClient;
}

const att = (id: string, mime: string, contentLength: number, title = `${id}.png`): Attachment =>
  ({ attachmentId: id, mime, contentLength, title }) as Attachment;

const textOf = (r: { content: Array<{ type: string }> } | null, i: number) =>
  (r?.content[i] as { text: string }).text;

describe('get_note image handling', () => {
  it('inlines only images referenced by the body, within the size caps', async () => {
    const html =
      '<p><img src="api/attachments/small/image/a.png"><img src="api/attachments/big/image/b.png"></p>';
    const client = mockClient({
      getNoteContent: vi.fn().mockResolvedValue(html),
      getNoteAttachments: vi
        .fn()
        .mockResolvedValue([
          att('small', 'image/png', 1000),
          att('big', 'image/png', 2 * 1024 * 1024),
          att('orphan', 'image/png', 10),
          att('doc', 'application/pdf', 10, 'doc.pdf'),
        ]),
    });
    const result = await handleNoteTool(client, 'get_note', { noteId: 'n1' });
    const images = result!.content.filter((b) => b.type === 'image');
    expect(images).toHaveLength(1);
    expect(client.getAttachmentContentAsBase64).toHaveBeenCalledTimes(1);
    expect(client.getAttachmentContentAsBase64).toHaveBeenCalledWith('small', 1024 * 1024);
    const body = textOf(result, 1);
    expect(body).toContain('"attachmentId":"big"');
    expect(body).toContain('get_attachment');
    // Unreferenced image and non-image are listed, not inlined.
    expect(body).toContain('orphan');
    expect(body).toContain('doc');
  });

  it('enforces the total image budget', async () => {
    const ids = ['i1', 'i2', 'i3', 'i4', 'i5'];
    const client = mockClient({
      getNoteContent: vi.fn().mockResolvedValue(ids.map((i) => `<img src="x/${i}/y">`).join('')),
      getNoteAttachments: vi
        .fn()
        .mockResolvedValue(ids.map((i) => att(i, 'image/png', 1000 * 1000))),
    });
    const result = await handleNoteTool(client, 'get_note', { noteId: 'n1' });
    expect(result!.content.filter((b) => b.type === 'image')).toHaveLength(4);
    expect(textOf(result, 1)).toContain('"attachmentId":"i5"');
  });

  it('does not fetch attachments on later pages', async () => {
    const client = mockClient({
      getNoteContent: vi.fn().mockResolvedValue('<img src="x/i1/y">' + 'z'.repeat(100)),
      getNoteAttachments: vi.fn().mockResolvedValue([att('i1', 'image/png', 10)]),
    });
    const result = await handleNoteTool(client, 'get_note', { noteId: 'n1', content_start: 50 });
    expect(client.getNoteAttachments).not.toHaveBeenCalled();
    expect(result!.content.some((b) => b.type === 'image')).toBe(false);
  });

  it('truncation notice does not steer toward markdown', async () => {
    const client = mockClient({ getNoteContent: vi.fn().mockResolvedValue('a'.repeat(100)) });
    const result = await handleNoteTool(client, 'get_note', {
      noteId: 'n1',
      content_max_chars: 10,
      includeImages: false,
    });
    expect(textOf(result, 1)).not.toContain('markdown');
  });
});

describe('write_note on binary notes', () => {
  const binaryNote = { noteId: 'n1', title: 'pic.png', type: 'image', mime: 'image/png' };

  it('replace uploads resolved bytes instead of text', async () => {
    const client = mockClient({ getNote: vi.fn().mockResolvedValue(binaryNote) });
    await handleNoteTool(client, 'write_note', {
      noteId: 'n1',
      mode: 'replace',
      content: `data:image/png;base64,${PNG_B64}`,
    });
    expect(client.updateNoteContent).not.toHaveBeenCalled();
    const sent = (client.updateNoteContentBinary as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect((sent as Buffer).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
  });

  it.each(['append', 'edit'])('rejects mode=%s', async (mode) => {
    const client = mockClient({ getNote: vi.fn().mockResolvedValue(binaryNote) });
    const args =
      mode === 'append'
        ? { noteId: 'n1', mode, content: 'x' }
        : { noteId: 'n1', mode, changes: [{ old_string: 'a', new_string: 'b' }] };
    await expect(handleNoteTool(client, 'write_note', args)).rejects.toThrow(/binary/);
    expect(client.updateNoteContent).not.toHaveBeenCalled();
    expect(client.updateNoteContentBinary).not.toHaveBeenCalled();
  });
});

describe('format="markdown" applies to text notes only', () => {
  it('create_note leaves code content untouched', async () => {
    const client = mockClient();
    await handleNoteTool(client, 'create_note', {
      parentNoteId: 'root',
      title: 'script',
      type: 'code',
      mime: 'text/x-python',
      content: '# comment\nprint(1)',
      format: 'markdown',
    });
    const def = (client.createNote as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(def.content).toBe('# comment\nprint(1)');
  });

  it('write_note replace leaves code content untouched', async () => {
    const client = mockClient({
      getNote: vi.fn().mockResolvedValue({ noteId: 'n1', type: 'code', mime: 'text/x-python' }),
    });
    await handleNoteTool(client, 'write_note', {
      noteId: 'n1',
      mode: 'replace',
      content: '# comment',
      format: 'markdown',
    });
    expect(client.updateNoteContent).toHaveBeenCalledWith('n1', '# comment');
  });
});

describe('create_note attachment pre-validation and partial failure', () => {
  it('fails on a bad image input before creating the note', async () => {
    const client = mockClient();
    await expect(
      handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'T',
        type: 'text',
        content: '<img src="image:0">',
        images: [{ data: 'data:image/png;base64,!!!notbase64' }],
      })
    ).rejects.toThrow();
    expect(client.createNote).not.toHaveBeenCalled();
  });

  it('fails on an out-of-range placeholder before creating the note', async () => {
    const client = mockClient();
    await expect(
      handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'T',
        type: 'text',
        content: '<img src="image:3">',
        images: [{ data: `data:image/png;base64,${PNG_B64}` }],
      })
    ).rejects.toThrow(/image:3/);
    expect(client.createNote).not.toHaveBeenCalled();
  });

  it('reports the created noteId and forbids retry when an upload fails', async () => {
    const client = mockClient({
      createAttachment: vi.fn().mockRejectedValue(new Error('disk full')),
    });
    const result = await handleNoteTool(client, 'create_note', {
      parentNoteId: 'root',
      title: 'T',
      type: 'text',
      content: '<img src="image:0">',
      images: [{ data: `data:image/png;base64,${PNG_B64}` }],
    });
    expect(result).toMatchObject({ isError: true });
    const payload = JSON.parse(textOf(result, 0));
    expect(payload.noteId).toBe('new1');
    expect(payload.error).toContain('was created');
    expect(payload.error).toContain('Do NOT retry create_note');
    expect(payload.error).toContain('disk full');
  });

  it('write_note does not touch content when an upload fails', async () => {
    const client = mockClient({
      createAttachment: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const result = await handleNoteTool(client, 'write_note', {
      noteId: 'n1',
      mode: 'replace',
      content: '<img src="image:0">',
      images: [{ data: `data:image/png;base64,${PNG_B64}` }],
    });
    expect(result).toMatchObject({ isError: true });
    expect(textOf(result, 0)).toContain('NOT');
    expect(client.updateNoteContent).not.toHaveBeenCalled();
  });
});

describe('substituteAttachmentPlaceholders', () => {
  const upload = (role: 'image' | 'file', index: number, title: string) => ({
    staged: { role, index, title, mime: 'x', isBinary: true, buffer: Buffer.alloc(0) },
    attachment: { attachmentId: 'a1', title } as Attachment,
  });

  it('URL-encodes titles and keeps $ patterns literal', () => {
    const out = substituteAttachmentPlaceholders('<img src="image:0">', [
      upload('image', 0, 'my $& pic$1.png'),
    ]);
    expect(out).toBe(
      `<img src="api/attachments/a1/image/${encodeURIComponent('my $& pic$1.png')}">`
    );
  });

  it('HTML-escapes appended file link text', () => {
    const out = substituteAttachmentPlaceholders('<p>x</p>', [
      upload('file', 0, '<script>a&b</script>.txt'),
    ]);
    expect(out).toContain('&lt;script&gt;a&amp;b&lt;/script&gt;.txt</a>');
    expect(out).not.toContain('<script>');
  });
});

describe('write_note edit verification', () => {
  it('says the write happened and asks for a re-read when verification fails', async () => {
    const client = mockClient({
      getNoteContent: vi
        .fn()
        .mockResolvedValueOnce('<p>hello world</p>')
        .mockResolvedValueOnce('<p>sanitized</p>'),
    });
    const err = await handleNoteTool(client, 'write_note', {
      noteId: 'n1',
      mode: 'edit',
      changes: [{ old_string: 'hello', new_string: 'bye' }],
    }).catch((e: Error) => e);
    expect(client.updateNoteContent).toHaveBeenCalled();
    expect((err as Error).message).toContain('WAS written');
    expect((err as Error).message).toContain('get_note');
  });

  it('verifies pure deletions', async () => {
    const client = mockClient({
      getNoteContent: vi
        .fn()
        .mockResolvedValueOnce('<p>keep DROP</p>')
        .mockResolvedValueOnce('<p>keep DROP</p>'),
    });
    await expect(
      handleNoteTool(client, 'write_note', {
        noteId: 'n1',
        mode: 'edit',
        changes: [{ old_string: ' DROP', new_string: '' }],
      })
    ).rejects.toThrow(/deleted text still present/);
  });
});

describe('create_note binary detection follows the note type (T1)', () => {
  it('keeps a frontend script as text even though its mime has parameters', async () => {
    const client = mockClient();
    const result = await handleNoteTool(client, 'create_note', {
      parentNoteId: 'root',
      title: 'script',
      type: 'code',
      mime: 'application/javascript;env=frontend',
      content: 'api.log(1)',
    });
    expect(result).not.toMatchObject({ isError: true });
    const def = (client.createNote as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(def.content).toBe('api.log(1)');
    expect(client.updateNoteContentBinary).not.toHaveBeenCalled();
  });

  it('never base64-decodes code content that happens to look like base64', async () => {
    const client = mockClient();
    await handleNoteTool(client, 'create_note', {
      parentNoteId: 'root',
      title: 'data',
      type: 'code',
      mime: 'application/octet-stream',
      content: 'YWJjZA==',
    });
    const def = (client.createNote as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(def.content).toBe('YWJjZA==');
    expect(client.updateNoteContentBinary).not.toHaveBeenCalled();
  });

  it('still uploads a file note with a binary mime as bytes', async () => {
    const client = mockClient();
    await handleNoteTool(client, 'create_note', {
      parentNoteId: 'root',
      title: 'pic.png',
      type: 'image',
      mime: 'image/png',
      content: PNG_B64,
    });
    const def = (client.createNote as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(def.content).toBe('');
    const sent = (client.updateNoteContentBinary as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect((sent as Buffer).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
  });
});

describe('create_note keeps the requested utcDateModified (T4)', () => {
  const DATE = '2020-01-15 09:30:00.000Z';

  it('restores it after the binary body upload', async () => {
    const order: string[] = [];
    const client = mockClient({
      updateNoteContentBinary: vi.fn(async () => void order.push('content')),
      updateNote: vi.fn(async () => void order.push('updateNote')),
    });
    const result = await handleNoteTool(client, 'create_note', {
      parentNoteId: 'root',
      title: 'pic.png',
      type: 'image',
      mime: 'image/png',
      content: PNG_B64,
      utcDateModified: DATE,
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(client.updateNote).toHaveBeenCalledWith('new1', { utcDateModified: DATE });
    expect(order).toEqual(['content', 'updateNote']);
  });

  it('restores it after the content write that embeds attachments', async () => {
    const order: string[] = [];
    const client = mockClient({
      updateNoteContent: vi.fn(async () => void order.push('content')),
      updateNote: vi.fn(async () => void order.push('updateNote')),
    });
    await handleNoteTool(client, 'create_note', {
      parentNoteId: 'root',
      title: 'T',
      type: 'text',
      content: '<img src="image:0">',
      images: [{ data: `data:image/png;base64,${PNG_B64}` }],
      utcDateModified: DATE,
    });
    expect(order).toEqual(['content', 'updateNote']);
    expect(client.updateNote).toHaveBeenCalledWith('new1', { utcDateModified: DATE });
  });

  it('does not touch the date when nothing was written after the create', async () => {
    const client = mockClient();
    await handleNoteTool(client, 'create_note', {
      parentNoteId: 'root',
      title: 'T',
      type: 'text',
      content: '<p>plain</p>',
      utcDateModified: DATE,
    });
    expect(client.updateNote).not.toHaveBeenCalled();
  });

  it('warns (without failing) when restoring the date fails', async () => {
    const client = mockClient({ updateNote: vi.fn().mockRejectedValue(new Error('too old')) });
    const result = await handleNoteTool(client, 'create_note', {
      parentNoteId: 'root',
      title: 'pic.png',
      type: 'image',
      mime: 'image/png',
      content: PNG_B64,
      utcDateModified: DATE,
    });
    expect(result).not.toMatchObject({ isError: true });
    const payload = JSON.parse(textOf(result, 0));
    expect(payload.note.noteId).toBe('new1');
    expect(payload.warning).toContain('utcDateModified');
    expect(payload.warning).toContain('too old');
    expect(payload.warning).toContain('mode:"metadata"');
  });
});

describe('orphaned attachments (P1)', () => {
  const imageCall = {
    parentNoteId: 'root',
    title: 'T',
    type: 'text',
    content: '<img src="image:0">',
    images: [{ data: `data:image/png;base64,${PNG_B64}` }],
  };

  it('deletes the empty attachment when its content upload fails', async () => {
    const client = mockClient({
      updateAttachmentContentBinary: vi.fn().mockRejectedValue(new Error('upload broke')),
      deleteAttachment: vi.fn(),
    });
    const result = await handleNoteTool(client, 'create_note', imageCall);
    expect(result).toMatchObject({ isError: true });
    expect(client.deleteAttachment).toHaveBeenCalledWith('att_11');
    const payload = JSON.parse(textOf(result, 0));
    expect(payload.error).toContain('upload broke');
    expect(payload.orphanedAttachments).toBeUndefined();
  });

  it('reports the attachmentId when the cleanup delete fails too', async () => {
    const client = mockClient({
      updateAttachmentContentBinary: vi.fn().mockRejectedValue(new Error('upload broke')),
      deleteAttachment: vi.fn().mockRejectedValue(new Error('delete broke')),
    });
    const result = await handleNoteTool(client, 'create_note', imageCall);
    const payload = JSON.parse(textOf(result, 0));
    expect(payload.orphanedAttachments).toEqual([
      { placeholder: 'image:0', attachmentId: 'att_11' },
    ]);
    expect(payload.error).toContain('att_11');
    expect(payload.error).toContain('delete broke');
  });

  it('write_note names the uploaded attachments when the content write fails afterwards', async () => {
    const client = mockClient({
      deleteAttachment: vi.fn(),
      updateNoteContent: vi.fn().mockRejectedValue(new Error('write broke')),
    });
    const result = await handleNoteTool(client, 'write_note', {
      noteId: 'n1',
      mode: 'replace',
      content: '<img src="image:0">',
      images: [{ data: `data:image/png;base64,${PNG_B64}` }],
    });
    expect(result).toMatchObject({ isError: true });
    const payload = JSON.parse(textOf(result, 0));
    expect(payload.error).toContain('write broke');
    expect(payload.error).toContain('WERE created');
    expect(payload.uploadedAttachments).toEqual([
      { placeholder: 'image:0', attachmentId: 'att_11', title: 'image-0.png' },
    ]);
  });

  it('write_note without attachments rethrows a content write failure unchanged', async () => {
    const client = mockClient({
      updateNoteContent: vi.fn().mockRejectedValue(new Error('write broke')),
    });
    await expect(
      handleNoteTool(client, 'write_note', { noteId: 'n1', mode: 'replace', content: '<p>x</p>' })
    ).rejects.toThrow('write broke');
  });
});

describe('get_note caps are visible (P2)', () => {
  afterEach(() => configureNoteTools({}));

  it('flags pathsTruncated when the note has more placements than maxPaths', async () => {
    configureNoteTools({ maxPaths: 2 });
    const client = mockClient({
      getNote: vi.fn(async (id: string) =>
        id === 'n1'
          ? {
              noteId: 'n1',
              title: 'T',
              type: 'text',
              mime: 'text/html',
              parentNoteIds: ['a', 'b', 'c'],
            }
          : { noteId: id, title: id.toUpperCase() }
      ),
      getNotePath: vi.fn(async (_id: string, parent: string) => `root/${parent}/n1`),
    });
    const result = await handleNoteTool(client, 'get_note', {
      noteId: 'n1',
      include_path: true,
      include_content: false,
    });
    const meta = JSON.parse(textOf(result, 0));
    expect(meta.paths).toHaveLength(2);
    expect(meta.pathsTruncated).toBe(true);
  });

  it('omits pathsTruncated when every placement fits', async () => {
    const client = mockClient({
      getNote: vi.fn().mockResolvedValue({ noteId: 'n1', title: 'T', parentNoteIds: ['a'] }),
    });
    const meta = JSON.parse(
      textOf(
        await handleNoteTool(client, 'get_note', {
          noteId: 'n1',
          include_path: true,
          include_content: false,
        }),
        0
      )
    );
    expect(meta.paths).toHaveLength(1);
    expect(meta.pathsTruncated).toBeUndefined();
  });

  it('flags backlinksTruncated beyond maxBacklinks, ignoring the note itself', async () => {
    configureNoteTools({ maxBacklinks: 2 });
    const hits = ['n1', 'x1', 'x2', 'x3'].map((noteId) => ({ noteId, title: noteId }));
    const client = mockClient({ searchNotes: vi.fn().mockResolvedValue({ results: hits }) });
    const meta = JSON.parse(
      textOf(
        await handleNoteTool(client, 'get_note', {
          noteId: 'n1',
          include_backlinks: true,
          include_content: false,
        }),
        0
      )
    );
    expect(meta.backlinks.map((b: { noteId: string }) => b.noteId)).toEqual(['x1', 'x2']);
    expect(meta.backlinksTruncated).toBe(true);
  });

  it('does not flag backlinks as truncated when only the note itself overflowed', async () => {
    configureNoteTools({ maxBacklinks: 2 });
    const hits = ['n1', 'x1', 'x2'].map((noteId) => ({ noteId, title: noteId }));
    const client = mockClient({ searchNotes: vi.fn().mockResolvedValue({ results: hits }) });
    const meta = JSON.parse(
      textOf(
        await handleNoteTool(client, 'get_note', {
          noteId: 'n1',
          include_backlinks: true,
          include_content: false,
        }),
        0
      )
    );
    expect(meta.backlinks).toHaveLength(2);
    expect(meta.backlinksTruncated).toBeUndefined();
  });

  it.each(['TRILIUM_BUSY', 'TRILIUM_TIMEOUT'])(
    'returns the note with backlinksError when the scan hits %s',
    async (code) => {
      const client = mockClient({
        getNoteContent: vi.fn().mockResolvedValue('<p>body</p>'),
        searchNotes: vi.fn().mockRejectedValue(new TriliumClientError(503, code, 'slow')),
      });
      const result = await handleNoteTool(client, 'get_note', {
        noteId: 'n1',
        include_backlinks: true,
        includeImages: false,
      });
      expect(result).not.toMatchObject({ isError: true });
      const meta = JSON.parse(textOf(result, 0));
      expect(meta.backlinks).toBeUndefined();
      expect(meta.backlinksError).toContain('slow');
      expect(textOf(result, 1)).toBe('<p>body</p>');
    }
  );

  it('still fails get_note on other backlink scan errors', async () => {
    const client = mockClient({
      searchNotes: vi
        .fn()
        .mockRejectedValue(new TriliumClientError(401, 'ETAPI_TOKEN_INVALID', 'no')),
    });
    await expect(
      handleNoteTool(client, 'get_note', { noteId: 'n1', include_backlinks: true })
    ).rejects.toThrow('no');
  });
});

describe('get_note on an image note (P4)', () => {
  const imageNote = { noteId: 'n1', title: 'pic', type: 'image', mime: 'image/png' };

  it('with includeImages=false tells the model how to get the image', async () => {
    const client = mockClient({
      getNote: vi.fn().mockResolvedValue(imageNote),
      getNoteContentBinary: vi.fn(),
    });
    const result = await handleNoteTool(client, 'get_note', { noteId: 'n1', includeImages: false });
    expect(client.getNoteContentBinary).not.toHaveBeenCalled();
    const notice = textOf(result, 1);
    expect(notice).toContain('includeImages=true');
    expect(notice).not.toContain('Do not retry');
  });

  it('a non-image binary still says not to retry', async () => {
    const client = mockClient({
      getNote: vi
        .fn()
        .mockResolvedValue({ noteId: 'n1', title: 'f', type: 'file', mime: 'application/pdf' }),
    });
    const result = await handleNoteTool(client, 'get_note', { noteId: 'n1' });
    expect(textOf(result, 1)).toContain('Do not retry');
  });
});

describe('get_note embedded image budgets', () => {
  afterEach(() => configureNoteTools({}));

  it('re-checks an image whose real size exceeds its declared size', async () => {
    configureNoteTools({ noteImageMaxBytes: 100, noteImagesTotalMaxBytes: 1000 });
    const big = Buffer.alloc(150).toString('base64');
    const client = mockClient({
      getNoteContent: vi.fn().mockResolvedValue('<img src="x/liar/y">'),
      getNoteAttachments: vi.fn().mockResolvedValue([att('liar', 'image/png', 10)]),
      getAttachmentContentAsBase64: vi.fn().mockResolvedValue(big),
    });
    const result = await handleNoteTool(client, 'get_note', { noteId: 'n1' });
    expect(result!.content.some((b) => b.type === 'image')).toBe(false);
    expect(textOf(result, 1)).toContain('"attachmentId":"liar","title":"liar.png","sizeBytes":150');
  });

  it('enforces the total budget on actual sizes when declared sizes are missing', async () => {
    configureNoteTools({ noteImageMaxBytes: 100, noteImagesTotalMaxBytes: 250 });
    const ids = ['i1', 'i2', 'i3', 'i4'];
    const budgets: number[] = [];
    const client = mockClient({
      getNoteContent: vi.fn().mockResolvedValue(ids.map((i) => `<img src="x/${i}/y">`).join('')),
      getNoteAttachments: vi.fn().mockResolvedValue(ids.map((i) => att(i, 'image/png', 0))),
      getAttachmentContentAsBase64: vi.fn(async (_id: string, budget: number) => {
        budgets.push(budget);
        return Buffer.alloc(80).toString('base64');
      }),
    });
    const result = await handleNoteTool(client, 'get_note', { noteId: 'n1' });
    expect(result!.content.filter((b) => b.type === 'image')).toHaveLength(3);
    // Each fetch is bounded by what is left of the total budget.
    expect(budgets).toEqual([100, 100, 90, 10]);
    expect(textOf(result, 1)).toContain('"attachmentId":"i4"');
  });
});

describe('images/files staging limits (T5)', () => {
  const saved = getContentInputPolicy();
  afterEach(() => configureContentInput(saved));

  it('caps the combined size of one call and creates nothing when over', async () => {
    // PNG_B64 decodes to 11 bytes; the per-call total is the per-input cap (25).
    configureContentInput({ ...saved, maxBytes: 25 });
    const client = mockClient();
    const image = { data: `data:image/png;base64,${PNG_B64}` };
    const err = await handleNoteTool(client, 'create_note', {
      parentNoteId: 'root',
      title: 'T',
      type: 'text',
      content: '<p>x</p>',
      images: [image, image, image],
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain('image:2');
    expect((err as Error).message).toContain('total at most 25 bytes');
    expect(client.createNote).not.toHaveBeenCalled();
  });

  it('counts files and images against the same budget', async () => {
    configureContentInput({ ...saved, maxBytes: 15 });
    const client = mockClient();
    const err = await handleNoteTool(client, 'write_note', {
      noteId: 'n1',
      mode: 'append',
      content: '<p>x</p>',
      images: [{ data: `data:image/png;base64,${PNG_B64}` }],
      files: [{ data: 'data:text/plain,hello world', filename: 'a.txt' }],
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain('file:0');
    expect(client.updateNoteContent).not.toHaveBeenCalled();
  });

  it('rejects more than the per-call attachment count', async () => {
    const client = mockClient();
    const image = { data: `data:image/png;base64,${PNG_B64}` };
    await expect(
      handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'T',
        type: 'text',
        content: '<p>x</p>',
        images: Array.from({ length: 51 }, () => image),
      })
    ).rejects.toThrow(/At most 50 images/);
  });

  it('uploads attachments one at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const client = mockClient({
      createAttachment: vi.fn(async (def: { title: string }) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return { attachmentId: `att_${def.title}`, title: def.title };
      }),
    });
    const image = { data: `data:image/png;base64,${PNG_B64}` };
    await handleNoteTool(client, 'create_note', {
      parentNoteId: 'root',
      title: 'T',
      type: 'text',
      content: '<p>x</p>',
      images: [image, image, image],
    });
    expect(client.createAttachment).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });
});
