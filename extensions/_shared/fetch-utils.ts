/**
 * Shared fetch-with-timeout utility for Pi extensions.
 *
 * Usage:
 *   import { fetchWithTimeout } from "../_shared/fetch-utils";
 *   const resp = await fetchWithTimeout(url, { method: "GET" }, 10_000, ctx.signal);
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(
  url: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  upstreamSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const cleanup: Array<() => void> = [];

  // Merge external signals
  for (const signal of [init.signal, upstreamSignal]) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      continue;
    }
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    cleanup.push(() => signal.removeEventListener("abort", abort));
  }

  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Strip signal from init to avoid conflicts — ours is the merged one
    const { signal: _s, headers, ...rest } = init;
    return await fetch(url, {
      ...rest,
      headers: headers as HeadersInit | undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    for (const removeListener of cleanup) removeListener();
  }
}

export interface RetryOptions {
  /** Max attempts including the first. Default 3. */
  attempts?: number;
  /** Base delay in ms for exponential backoff. Default 500. */
  baseDelayMs?: number;
  /** Cap for a single backoff delay. Default 8000. */
  maxDelayMs?: number;
  /** Abort signal; when aborted, stop retrying and rethrow. */
  signal?: AbortSignal;
  /** Decide whether an error is worth retrying. Default: transient network errors. */
  shouldRetry?: (error: unknown) => boolean;
  /** Optional callback before each retry (for logging/UI). */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/** Names/patterns of transient network conditions worth retrying. */
const TRANSIENT_RE =
  /(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network|fetch failed|terminated)/i;

/** True for transient network errors (not user aborts, not HTTP-status errors). */
export function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    // Never retry a deliberate abort.
    if (error.name === "AbortError") return false;
    const code = (error as NodeJS.ErrnoException).code;
    if (code && TRANSIENT_RE.test(code)) return true;
    if (TRANSIENT_RE.test(error.message)) return true;
    // node fetch wraps the real cause
    const cause = (error as { cause?: unknown }).cause;
    if (cause && cause !== error) return isTransientNetworkError(cause);
  }
  return false;
}

/**
 * Run an async operation with exponential backoff on transient failures.
 * Only retries errors deemed transient (default: network-level). HTTP status
 * errors surfaced as thrown Errors by callers are retried only if the caller's
 * `shouldRetry` opts in.
 */
export async function retryAsync<T>(op: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8000;
  const shouldRetry = options.shouldRetry ?? isTransientNetworkError;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) throw new Error("Aborted");
    try {
      return await op();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      // Full jitter to avoid thundering herd on shared endpoints.
      const delayMs = Math.floor(Math.random() * backoff);
      options.onRetry?.({ attempt, delayMs, error });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new Error("Aborted"));
          },
          { once: true },
        );
      });
    }
  }
  throw lastError;
}
