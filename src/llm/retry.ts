/**
 * Provider-layer retry (ML-2).
 *
 * Canonical home for transient-error classification and backoff. The agent
 * loop keeps its coarse per-iteration handling, but every network call made
 * by a provider adapter goes through `withProviderRetry`, which adds
 * exponential backoff with full jitter and honors `Retry-After`.
 *
 * Auth errors (401/403/bad key) never resolve by retrying and fail fast.
 */

export interface RetryOptions {
  /** Max attempts including the first try (default 4). */
  maxAttempts?: number;
  /** Base delay before jitter (default 1_000 ms). */
  baseMs?: number;
  /** Hard cap for any single wait (default 30_000 ms). */
  maxMs?: number;
  /** Cancel waiting / further attempts. */
  signal?: AbortSignal;
  /** Injectable clock for tests (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Observe retries (logging, tests). */
  onRetry?: (attempt: number, waitMs: number, message: string) => void;
  /** Random source for jitter (default Math.random). */
  random?: () => number;
}

/** 401/403s never resolve by retrying — fail immediately with a fix. */
export function isAuthError(message: string): boolean {
  return /401|403|invalid api key|incorrect api key|unauthorized|authentication/i.test(message);
}

export function isRateLimitError(message: string): boolean {
  return /429|413|rate.?limit|too many requests|tokens per minute|\bTPM\b|\bRPD\b|overloaded|capacity/i.test(
    message,
  );
}

type ErrorLike = {
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  headers?: unknown;
  response?: { headers?: unknown; status?: unknown };
};

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as ErrorLike;
  for (const candidate of [e.status, e.statusCode, e.response?.status]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string" && /^\d+$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const m = (error as ErrorLike).message;
    if (typeof m === "string") return m;
  }
  return String(error);
}

/**
 * Retryable = rate limits, 5xx, overloaded/capacity, timeouts and network
 * blips. Auth failures, 400s (other than 413/429 shaped as rate limits),
 * and aborts are not retryable.
 */
export function isRetryableProviderError(error: unknown): boolean {
  const message = errorMessage(error);
  if (isAuthError(message)) return false;
  const status = errorStatus(error);
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status < 600) return true;
  if (status === 408 || status === 413) return true;
  if (status !== undefined && status >= 400 && status < 500) return false;
  if (isRateLimitError(message)) return true;
  return /timeout|timed out|econnreset|econnrefused|enotfound|eai_again|socket hang up|network|fetch failed|truncated|unexpected end|service unavailable|bad gateway|gateway timeout|no_available_workers|no available workers|circuits open/i.test(
    message,
  );
}

/** Parse a `Retry-After` header value (seconds or HTTP date) into ms. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (value == null) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
  return undefined;
}

/** Pull `Retry-After` (ms) off an SDK-style error, if present. */
export function retryAfterMsFromError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as ErrorLike;
  const headers = [e.headers, e.response?.headers];
  for (const h of headers) {
    if (typeof h === "object" && h !== null) {
      const get = (h as Record<string, unknown>).get;
      if (typeof get === "function") {
        try {
          const v = (get as (k: string) => unknown).call(h, "retry-after");
          const ms = parseRetryAfterMs(typeof v === "string" ? v : v == null ? null : String(v));
          if (ms !== undefined) return ms;
        } catch {
          // fall through to plain-object lookup
        }
      }
      const record = h as Record<string, unknown>;
      for (const key of ["retry-after", "Retry-After", "RETRY-AFTER"]) {
        if (record[key] !== undefined) {
          const ms = parseRetryAfterMs(String(record[key]));
          if (ms !== undefined) return ms;
        }
      }
    }
  }
  return undefined;
}

/**
 * Exponential backoff with full jitter: wait = random(0, min(cap, base * 2^attempt)).
 * A server `Retry-After` raises the ceiling instead of being ignored.
 */
export function retryDelayMs(
  attempt: number,
  baseMs = 1000,
  maxMs = 30_000,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, Math.max(baseMs, retryAfterMs ?? 0, baseMs * 2 ** attempt));
  return Math.floor(random() * ceiling);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` until it succeeds, the error is not retryable, attempts run out,
 * or `signal` aborts. The last error is rethrown.
 */
export async function withProviderRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const baseMs = opts.baseMs ?? 1000;
  const maxMs = opts.maxMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  let attempt = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new Error("Provider request cancelled (AbortSignal).");
    try {
      return await fn(attempt);
    } catch (error) {
      attempt++;
      const message = errorMessage(error);
      const retryable = isRetryableProviderError(error);
      if (!retryable || attempt >= maxAttempts) throw error;
      const serverWait = retryAfterMsFromError(error);
      // Retry-After wins when it exceeds the jittered backoff; still capped.
      const waitMs = Math.min(
        maxMs,
        Math.max(retryDelayMs(attempt, baseMs, maxMs, undefined, random), Math.min(serverWait ?? 0, maxMs)),
      );
      opts.onRetry?.(attempt, waitMs, message);
      await sleep(waitMs);
    }
  }
}
