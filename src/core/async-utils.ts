/**
 * Shared async utilities for sync operations.
 *
 * Extracted from analytics-sync-v2.ts and order-sync.ts to eliminate
 * duplicated sleepWithAbort / abortError / Sleep implementations.
 */

/** Sleep function signature used by sync operations. */
export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

/** Create a standard abort error for sync operations. */
export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Sleep for the given duration, but abort early if the signal fires.
 *
 * Throws abortError() if the signal is already aborted or fires during sleep.
 */
export async function sleepWithAbort(
  sleep: Sleep,
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) throw abortError();
  await Promise.race([
    sleep(milliseconds, signal),
    new Promise<never>((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(abortError()), { once: true }),
    ),
  ]);
  if (signal?.aborted) throw abortError();
}

/**
 * Abortable delay using setTimeout.
 *
 * Unlike sleepWithAbort (which delegates to an injected Sleep function),
 * this uses setTimeout directly. Useful when no external Sleep is available.
 */
export function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timeout = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}