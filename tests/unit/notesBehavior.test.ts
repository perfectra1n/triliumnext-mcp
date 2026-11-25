import { describe, it, expect, vi } from 'vitest';
import { handleNoteTool, substituteAttachmentPlaceholders } from '../../src/tools/notes.js';
import type { TriliumClient } from '../../src/client/trilium.js';
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
