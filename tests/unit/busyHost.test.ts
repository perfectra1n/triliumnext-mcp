import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TriliumClient, clientOptionsFromConfig } from '../../src/client/trilium.js';
import { getBusy, markBusy, resetHostState } from '../../src/client/hostGuard.js';

const HOST = 'http://busy/etapi';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

/** A fetch that never answers until its abort signal fires. */
const hang = (_url: string, init: { signal: AbortSignal }) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });

describe('busy Trilium handling', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetHostState();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetHostState();
  });

  const client = (opts = {}, token = 'tok') =>
    new TriliumClient(HOST, token, undefined, { retryDelayMs: 0, ...opts });

  it('marks the host busy after a timeout and refuses body searches without calling Trilium', async () => {
    mockFetch.mockImplementationOnce(hang);
    const c = client({ timeoutMs: 20, busyCooldownMs: 10_000 });

    await expect(c.searchNotes({ search: 'afi' })).rejects.toMatchObject({
      code: 'TRILIUM_TIMEOUT',
    });
    expect(getBusy(HOST)?.reason).toBe('GET /notes');

    await expect(c.searchNotes({ search: 'other' })).rejects.toMatchObject({
      code: 'TRILIUM_BUSY',
      status: 503,
      message: expect.stringContaining('Try again in about'),
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(c.busyRetryAfterSeconds()).toBeGreaterThan(0);
  });

  it('shares the busy flag between clients for the same host', async () => {
    markBusy(HOST, 10_000, 'GET /notes');
    await expect(client({}, 'another-token').searchNotes({ search: 'afi' })).rejects.toMatchObject({
      code: 'TRILIUM_BUSY',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('treats a fastSearch that names note.content as expensive', async () => {
    markBusy(HOST, 10_000, 'GET /notes');
    await expect(
      client().searchNotes({ search: 'note.content *=* afi', fastSearch: true })
    ).rejects.toMatchObject({ code: 'TRILIUM_BUSY' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lets cheap requests through while busy and clears the flag when Trilium answers', async () => {
    markBusy(HOST, 10_000, 'GET /notes');
    mockFetch.mockResolvedValueOnce(ok({ results: [] }));
    await expect(client().searchNotes({ search: 'afi', fastSearch: true })).resolves.toEqual({
      results: [],
    });
    expect(getBusy(HOST)).toBeUndefined();
  });

  it('gives cheap requests a short timeout while busy and reports TRILIUM_BUSY', async () => {
    markBusy(HOST, 10_000, 'GET /notes');
    mockFetch.mockImplementation(hang);
    const started = Date.now();
    await expect(
      client({ timeoutMs: 60_000, busyProbeTimeoutMs: 20 }).getNote('n1')
    ).rejects.toMatchObject({
      code: 'TRILIUM_BUSY',
      message: expect.stringContaining('GET /notes timed out'),
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('shares one request between identical concurrent searches', async () => {
    let answer: (value: unknown) => void = () => undefined;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    const c = client();
    const first = c.searchNotes({ search: 'afi' });
    const second = c.searchNotes({ search: 'afi' });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    answer(ok({ results: [{ noteId: 'n1' }] }));

    const [a, b] = await Promise.all([first, second]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ results: [{ noteId: 'n1' }] });
    expect(b).toEqual(a);
    // Separate copies, so one caller decorating results cannot affect another.
    expect(b).not.toBe(a);
  });

  it('does not share requests between different tokens or different queries', async () => {
    mockFetch.mockImplementation(async () => ok({ results: [] }));
    await Promise.all([
      client({}, 'a').searchNotes({ search: 'afi' }),
      client({}, 'b').searchNotes({ search: 'afi' }),
      client({}, 'a').searchNotes({ search: 'other' }),
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('maps server config onto client options', () => {
    expect(clientOptionsFromConfig({ requestTimeoutMs: 90_000, busyCooldownMs: 5_000 })).toEqual({
      timeoutMs: 90_000,
      busyCooldownMs: 5_000,
    });
  });

  it('uses the configured request timeout', async () => {
    mockFetch.mockImplementation(hang);
    await expect(client({ timeoutMs: 25 }).getNote('n1')).rejects.toMatchObject({
      code: 'TRILIUM_TIMEOUT',
      message: expect.stringContaining('within 25ms'),
    });
  });
});
