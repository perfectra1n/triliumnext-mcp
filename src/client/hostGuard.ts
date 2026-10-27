/**
 * Process-wide health state for each Trilium backend, shared by every
 * TriliumClient. Multi-tenant mode builds one client per session, so state kept
 * on a client would be forgotten as soon as the next session connected.
 *
 * Why it exists: Trilium runs its SQL on a single thread, and a full-text
 * search is a `LIKE '%…%'` scan over the text of every note and attachment. On
 * a large instance one scan can hold Trilium for minutes, and even trivial
 * requests queue behind it. Aborting our fetch does not stop the scan. So once
 * a request times out we treat the host as busy for a cooldown: new expensive
 * requests are refused at once (each would only queue another scan), and cheap
 * ones get a short timeout so they fail fast instead of hanging for the full
 * request timeout. The first cheap request Trilium answers clears the flag.
 */

export interface BusyState {
  /** When the host was first marked busy (epoch ms). */
  since: number;
  /** When the flag lapses unless renewed (epoch ms). */
  until: number;
  /** The request that first timed out, e.g. "GET /notes". */
  reason: string;
}

const busyHosts = new Map<string, BusyState>();
const inflight = new Map<string, Promise<unknown>>();

export function getBusy(host: string, now: number = Date.now()): BusyState | undefined {
  const state = busyHosts.get(host);
  if (state === undefined) return undefined;
  if (state.until <= now) {
    busyHosts.delete(host);
    return undefined;
  }
  return state;
}

/** Mark (or keep) a host busy; an existing flag keeps its start time and first reason. */
export function markBusy(
  host: string,
  cooldownMs: number,
  reason: string,
  now: number = Date.now()
): BusyState {
  const previous = getBusy(host, now);
  const state: BusyState = {
    since: previous?.since ?? now,
    until: Math.max(previous?.until ?? 0, now + cooldownMs),
    reason: previous?.reason ?? reason,
  };
  busyHosts.set(host, state);
  return state;
}

export function clearBusy(host: string): void {
  busyHosts.delete(host);
}

export function retryAfterSeconds(state: BusyState, now: number = Date.now()): number {
  return Math.max(1, Math.ceil((state.until - now) / 1000));
}

/**
 * Share one in-flight promise between identical concurrent calls, so two
 * callers asking the same slow question cost Trilium one scan, not two.
 * The key must include everything that changes the answer (URL and token).
 */
export function dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing !== undefined) return existing as Promise<T>;
  const promise: Promise<T> = run().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/** Test hook: forget all busy flags and in-flight requests. */
export function resetHostState(): void {
  busyHosts.clear();
  inflight.clear();
}
