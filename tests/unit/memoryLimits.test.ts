import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TriliumClient,
  TriliumClientError,
  TriliumResponseTooLargeError,
} from '../../src/client/trilium.js';
import {
  handleAttachmentTool,
  registerAttachmentTools,
  configureAttachmentTools,
} from '../../src/tools/attachments.js';
import { handleNoteTool, configureNoteTools } from '../../src/tools/notes.js';
import { handleSystemTool, configureSystemTools } from '../../src/tools/system.js';

/**
 * Regression tests for the OOM fix: nothing may buffer or base64-encode an
 * unbounded Trilium body. A 256 MiB pod was killed by one get_note on an
 * 8 MiB PNG (per-byte String.fromCharCode + btoa, all images in parallel).
 */

const MiB = 1024 * 1024;

/** A PNG-signature buffer of the given size (so file-type sniffs it as binary). */
function pngOfSize(size: number): Buffer {
  const buf = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  for (let i = 8; i < size; i++) buf[i] = (i * 31) & 0xff;
  return buf;
}

/** A real streaming Response, optionally without Content-Length (chunked). */
function streamingResponse(bytes: Buffer, { declareLength = true, chunk = 64 * 1024 } = {}) {
  let offset = 0;
  const pulled = { bytes: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const piece = bytes.subarray(offset, offset + chunk);
      offset += piece.length;
      pulled.bytes += piece.length;
      controller.enqueue(new Uint8Array(piece));
    },
  });
  const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
  if (declareLength) headers.set('Content-Length', String(bytes.length));
  return { response: new Response(stream, { status: 200, headers }), pulled };
}

function clientReturning(response: Response, options = {}): TriliumClient {
  return new TriliumClient('http://t/etapi', 'tok', undefined, {
    fetchImpl: vi.fn().mockResolvedValue(response),
    maxRetries: 0,
    ...options,
  });
}

afterEach(() => {
  configureAttachmentTools({});
  configureNoteTools({});
  configureSystemTools({});
});

describe('client response caps', () => {
  it('base64-encodes a multi-MiB image correctly (Buffer, not a per-byte loop)', async () => {
    const png = pngOfSize(3 * MiB + 7);
    const { response } = streamingResponse(png);
    const out = await clientReturning(response).getAttachmentContentAsBase64('a1');
    expect(out.length).toBe(Math.ceil(png.length / 3) * 4);
    expect(out).toBe(png.toString('base64'));
    expect(Buffer.from(out, 'base64').equals(png)).toBe(true);
  });

  it('refuses a body whose Content-Length exceeds maxBytes without reading it', async () => {
    const { response, pulled } = streamingResponse(pngOfSize(2 * MiB));
    const err = await clientReturning(response)
      .getAttachmentContentBinary('a1', 1 * MiB)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TriliumResponseTooLargeError);
    expect((err as TriliumResponseTooLargeError).sizeBytes).toBe(2 * MiB);
    expect((err as TriliumClientError).code).toBe('RESPONSE_TOO_LARGE');
    // At most the stream's initial buffering — nowhere near the whole body.
    expect(pulled.bytes).toBeLessThan(2 * MiB);
  });

  it('stops reading a chunked body once it passes maxBytes', async () => {
    const { response, pulled } = streamingResponse(pngOfSize(4 * MiB), { declareLength: false });
    await expect(
      clientReturning(response).getAttachmentContentBinary('a1', 1 * MiB)
    ).rejects.toBeInstanceOf(TriliumResponseTooLargeError);
    expect(pulled.bytes).toBeLessThan(2 * MiB);
  });

  it('applies the client-wide maxResponseBytes to every request', async () => {
    const { response } = streamingResponse(Buffer.from('x'.repeat(2048)), { declareLength: false });
    const client = clientReturning(response, { maxResponseBytes: 1024 });
    await expect(client.getNoteContent('n1')).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      status: 413,
    });
  });

  it('a per-call maxBytes can only lower the client-wide cap', async () => {
    const { response } = streamingResponse(pngOfSize(4096));
    const client = clientReturning(response, { maxResponseBytes: 1024 });
    await expect(client.getAttachmentContentBinary('a1', 10 * MiB)).rejects.toBeInstanceOf(
      TriliumResponseTooLargeError
    );
  });

  it('still reads bodies under the cap', async () => {
    const png = pngOfSize(4096);
    const { response } = streamingResponse(png, { declareLength: false });
    const out = await clientReturning(response).getAttachmentContentBinary('a1', 8192);
    expect(out.equals(png)).toBe(true);
  });
});

function attachmentClient(overrides: Partial<TriliumClient>): TriliumClient {
  return {
    getAttachment: vi.fn(),
    getAttachmentContent: vi.fn(),
    getAttachmentContentBinary: vi.fn(),
    getAttachmentContentAsBase64: vi.fn(),
    ...overrides,
  } as unknown as TriliumClient;
}

describe('get_attachment caps images too', () => {
  it('returns metadata + notice for an oversized image and never fetches its content', async () => {
    const client = attachmentClient({
      getAttachment: vi.fn().mockResolvedValue({
        attachmentId: 'big',
        title: 'photo.png',
        mime: 'image/png',
        contentLength: 8.3 * MiB,
      }),
    });
    const result = await handleAttachmentTool(client, 'get_attachment', { attachmentId: 'big' });
    expect(result?.content).toHaveLength(1);
    expect(result?.content[0].type).toBe('text');
    const payload = JSON.parse((result?.content[0] as { text: string }).text);
    expect(payload).toMatchObject({ attachmentId: 'big', mime: 'image/png' });
    expect(payload.notice).toMatch(/too large to inline/);
    expect(payload.notice).toMatch(/open it in Trilium/);
    expect(client.getAttachmentContentAsBase64).not.toHaveBeenCalled();
    expect(client.getAttachmentContentBinary).not.toHaveBeenCalled();
    expect(client.getAttachmentContent).not.toHaveBeenCalled();
  });

  it('passes the cap to the fetch and returns the notice when the actual body is too large', async () => {
    const client = attachmentClient({
      getAttachment: vi.fn().mockResolvedValue({
        attachmentId: 'liar',
        mime: 'image/jpeg',
        contentLength: 0, // absent / stale
      }),
      getAttachmentContentAsBase64: vi
        .fn()
        .mockRejectedValue(new TriliumResponseTooLargeError(6 * MiB, 5 * MiB, 'GET x')),
    });
    const result = await handleAttachmentTool(client, 'get_attachment', { attachmentId: 'liar' });
    const payload = JSON.parse((result?.content[0] as { text: string }).text);
    expect(payload.notice).toMatch(/at least 6291456 bytes/);
    expect(client.getAttachmentContentAsBase64).toHaveBeenCalledWith('liar', 5 * MiB);
  });

  it('re-checks the decoded size after fetching', async () => {
    const client = attachmentClient({
      getAttachment: vi.fn().mockResolvedValue({ attachmentId: 'a', mime: 'image/png' }),
      getAttachmentContentAsBase64: vi
        .fn()
        .mockResolvedValue(Buffer.alloc(2048).toString('base64')),
    });
    configureAttachmentTools({ maxInlineAttachmentBytes: 1024 });
    const result = await handleAttachmentTool(client, 'get_attachment', { attachmentId: 'a' });
    expect(result?.content[0].type).toBe('text');
    expect((result?.content[0] as { text: string }).text).toMatch(/too large to inline/);
  });

  it('still inlines an image within the cap', async () => {
    const data = Buffer.alloc(1024).toString('base64');
    const client = attachmentClient({
      getAttachment: vi
        .fn()
        .mockResolvedValue({ attachmentId: 'a', mime: 'image/png', contentLength: 1024 }),
      getAttachmentContentAsBase64: vi.fn().mockResolvedValue(data),
    });
    const result = await handleAttachmentTool(client, 'get_attachment', { attachmentId: 'a' });
    expect(result?.content[0]).toEqual({ type: 'image', data, mimeType: 'image/png' });
  });

  it('describes the configured cap', () => {
    configureAttachmentTools({ maxInlineAttachmentBytes: 2 * MiB });
    const tool = registerAttachmentTools().find((t) => t.name === 'get_attachment');
    expect(tool?.description).toContain('2 MB');
  });
});

function noteClient(overrides: Partial<TriliumClient>): TriliumClient {
  return {
    getNote: vi.fn(),
    getNoteContent: vi.fn(),
    getNoteContentBinary: vi.fn(),
    getNoteAttachments: vi.fn().mockResolvedValue([]),
    getAttachmentContentAsBase64: vi.fn(),
    ...overrides,
  } as unknown as TriliumClient;
}

describe('get_note memory bounds', () => {
  it('lists an embedded image as skipped when its real size passes the budget', async () => {
    const client = noteClient({
      getNote: vi.fn().mockResolvedValue({ noteId: 'n1', type: 'text', mime: 'text/html' }),
      getNoteContent: vi.fn().mockResolvedValue('<img src="api/attachments/img1/image/x.png">'),
      getNoteAttachments: vi
        .fn()
        .mockResolvedValue([
          { attachmentId: 'img1', title: 'x.png', mime: 'image/png', contentLength: 0 },
        ]),
      getAttachmentContentAsBase64: vi
        .fn()
        .mockRejectedValue(new TriliumResponseTooLargeError(3 * MiB, MiB, 'GET x')),
    });
    const result = await handleNoteTool(client, 'get_note', { noteId: 'n1' });
    const body = (result?.content[1] as { text: string }).text;
    expect(body).toMatch(/Images not inlined \(size limit\)/);
    expect(body).toContain('img1');
    expect(body).not.toMatch(/could not be loaded/);
    expect(client.getAttachmentContentAsBase64).toHaveBeenCalledWith('img1', MiB);
  });

  it('does not decode a binary file note as text', async () => {
    const client = noteClient({
      getNote: vi
        .fn()
        .mockResolvedValue({ noteId: 'f1', type: 'file', mime: 'application/pdf', title: 'a' }),
    });
    const result = await handleNoteTool(client, 'get_note', { noteId: 'f1' });
    expect(client.getNoteContent).not.toHaveBeenCalled();
    expect(client.getNoteContentBinary).not.toHaveBeenCalled();
    expect((result?.content[1] as { text: string }).text).toMatch(/open the note in Trilium/);
  });

  it('inlines a small image note as an image block, capped by the per-image limit', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const client = noteClient({
      getNote: vi.fn().mockResolvedValue({ noteId: 'i1', type: 'image', mime: 'image/png' }),
      getNoteContentBinary: vi.fn().mockResolvedValue(png),
    });
    const result = await handleNoteTool(client, 'get_note', { noteId: 'i1' });
    expect(client.getNoteContentBinary).toHaveBeenCalledWith('i1', MiB);
    expect(result?.content[1]).toEqual({
      type: 'image',
      data: png.toString('base64'),
      mimeType: 'image/png',
    });
  });

  it('returns a notice for an image note over the per-image limit', async () => {
    const client = noteClient({
      getNote: vi.fn().mockResolvedValue({ noteId: 'i1', type: 'image', mime: 'image/png' }),
      getNoteContentBinary: vi
        .fn()
        .mockRejectedValue(new TriliumResponseTooLargeError(9 * MiB, MiB, 'GET x')),
    });
    const result = await handleNoteTool(client, 'get_note', { noteId: 'i1' });
    expect((result?.content[1] as { text: string }).text).toMatch(/too large to inline/);
  });
});

describe('manage_system export is capped at the transport', () => {
  it('maps a refused download to EXPORT_TOO_LARGE', async () => {
    const client = {
      exportNote: vi
        .fn()
        .mockRejectedValue(new TriliumResponseTooLargeError(50 * MiB, 10 * MiB, 'GET export')),
    } as unknown as TriliumClient;
    const err = await handleSystemTool(client, 'manage_system', {
      action: 'export',
      noteId: 'root',
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'EXPORT_TOO_LARGE' });
    expect((err as Error).message).toMatch(/at least 52428800 bytes/);
    expect(client.exportNote).toHaveBeenCalledWith('root', 'html', 10 * MiB);
  });

  it('honours a configured export cap', async () => {
    configureSystemTools({ maxExportBytes: 1024 });
    const client = {
      exportNote: vi.fn().mockResolvedValue(Buffer.alloc(10)),
    } as unknown as TriliumClient;
    await handleSystemTool(client, 'manage_system', { action: 'export', noteId: 'root' });
    expect(client.exportNote).toHaveBeenCalledWith('root', 'html', 1024);
  });
});
