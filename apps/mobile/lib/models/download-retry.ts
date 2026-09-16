// When a download that failed is worth simply asking for again.
//
// This module is the POLICY — how many times, how long to wait, and whether the
// user wants any of it — and it is deliberately backend-agnostic: it knows
// nothing about GenieX, HTTP, or where the bytes are going. Which failures are
// worth retrying is a question only the backend can answer, so the caller
// supplies that verdict (for the Qualcomm path it is
// `isTransientPullFailure` in npu-errors.ts). That split is what lets a second
// backend get its own classification later without a second copy of the
// waiting, counting and cancelling.
//
// ## Why retrying is the right recovery here, rather than re-downloading
//
// It is not a workaround for a broken transfer — it is how the SDK's own
// downloader is built to be used. `libgeniex.so` carries `GENIEX_DL_CHUNK_SIZE`,
// `byte range starts at `, `local range short read for `, and two
// `get_range retry ` messages (one for a transport error, one for an HTTP
// status), and it writes into `.inflight` beside a `.progress` file. So it
// fetches ranged chunks, retries them internally, and keeps what it already
// has. When its own retries are exhausted the pull fails — but the partial
// bundle is still on disk, and the observed behaviour on device matches
// exactly: a pull that failed at ~97% of 2.4 GB, retried, fetched roughly the
// remainder rather than starting again.
//
// That is why nothing here deletes anything. The whole value of a retry is the
// bytes the last attempt left behind.

import { getConfig, setConfig } from "../storage/database";
import type { RetryState } from "./types";

/** "Unlimited" is a real choice, so the cap is a number or the absence of one. */
export type RetryLimit = number | "unlimited";

export interface DownloadRetrySettings {
  /** Retry a transient failure without asking. */
  autoRetry: boolean;
  /** How many automatic attempts follow the first failure. */
  maxRetries: RetryLimit;
}

/**
 * On, and three.
 *
 * On because this is recovery from an interrupted transfer, not a behaviour
 * change: the alternative is a user watching 2.4 GB fail at 97% and pressing a
 * button that does exactly what this would have done. Three because the failure
 * observed on device is transient — the same request succeeded later, unchanged
 * — and a handful of attempts is what transient means. Anyone who wants more
 * can say so; the setting exists because "keep trying forever" is a legitimate
 * thing to want on a bad connection and a bad thing to impose by default.
 */
export const DEFAULT_DOWNLOAD_RETRY: DownloadRetrySettings = {
  autoRetry: true,
  maxRetries: 3,
};

/** The choices the Advanced setting offers. Kept here so the UI cannot drift. */
export const RETRY_LIMIT_CHOICES: RetryLimit[] = [1, 3, 5, "unlimited"];

const KEY = "download_retry";

/**
 * Read at the moment a decision is needed, never cached.
 *
 * That is what makes the setting live: a user who turns auto-retry off while a
 * download is backing off is answered by the next decision, not by the value
 * that was read when the install started. No reload, no restart.
 */
export async function getDownloadRetrySettings(): Promise<DownloadRetrySettings> {
  try {
    const raw = await getConfig(KEY);
    if (!raw) return { ...DEFAULT_DOWNLOAD_RETRY };
    return normalizeRetrySettings(JSON.parse(raw));
  } catch {
    // An unreadable or malformed setting is not a reason to change behaviour.
    return { ...DEFAULT_DOWNLOAD_RETRY };
  }
}

export async function setDownloadRetrySettings(
  s: DownloadRetrySettings,
): Promise<void> {
  await setConfig(KEY, JSON.stringify(s));
}

/**
 * Whatever was stored, read as one of the shapes this module accepts.
 *
 * Persisted settings outlive the code that wrote them. A value that is not one
 * of the offered choices falls back to the default rather than becoming a cap
 * of NaN, which would compare false against everything and quietly mean "never
 * retry".
 */
export function normalizeRetrySettings(raw: unknown): DownloadRetrySettings {
  const o = (raw ?? {}) as Partial<DownloadRetrySettings>;
  const limit = o.maxRetries;
  const maxRetries: RetryLimit =
    limit === "unlimited"
      ? "unlimited"
      : typeof limit === "number" && Number.isFinite(limit) && limit >= 0
        ? Math.floor(limit)
        : DEFAULT_DOWNLOAD_RETRY.maxRetries;
  return {
    autoRetry:
      typeof o.autoRetry === "boolean"
        ? o.autoRetry
        : DEFAULT_DOWNLOAD_RETRY.autoRetry,
    maxRetries,
  };
}

/**
 * Whether an attempt that has already failed `completed` times gets another.
 *
 * `completed` counts failures so far, so 0 means the first attempt has just
 * failed and this decides whether retry 1 happens.
 */
export function retryAllowed(
  completed: number,
  settings: DownloadRetrySettings,
): boolean {
  if (!settings.autoRetry) return false;
  if (settings.maxRetries === "unlimited") return true;
  return completed < settings.maxRetries;
}

/**
 * How long to wait before attempt number `attempt` (1-based).
 *
 * 2s, 5s, then 10s for everything after. Bounded on purpose: a transient
 * network failure clears in seconds, and an unbounded exponential backoff on a
 * multi-gigabyte download just means the user is looking at a screen that says
 * "retrying in 4 minutes". "Unlimited" retries use the same ceiling, which is
 * what keeps forever-retrying from becoming a tight loop.
 */
export function retryDelayMs(attempt: number): number {
  if (attempt <= 1) return 2_000;
  if (attempt === 2) return 5_000;
  return 10_000;
}

/** "Retrying 2 of 3…" / "Retrying 2…" when the user asked for unlimited. */
export function describeRetry(state: RetryState): string {
  const of = state.max === null ? "" : ` of ${state.max}`;
  const head = `Download interrupted. Retrying ${state.attempt}${of}…`;
  return state.secondsRemaining > 0
    ? `${head} (in ${state.secondsRemaining}s)`
    : head;
}

/**
 * A wait that can be cut short, and that reports the countdown as it goes.
 *
 * Interruptible rather than a plain sleep because Cancel has to work DURING the
 * wait: a user who has decided to stop should not watch ten seconds of a
 * countdown for a download that is already over. It resolves `false` when it
 * was aborted and `true` when the full time elapsed, so the caller can tell
 * "time to retry" from "stop".
 *
 * `onTick` is called once per second with the seconds remaining, so the screen
 * counts down without this module knowing anything about the screen.
 */
export async function waitForRetry(
  ms: number,
  signal: AbortSignal,
  onTick?: (secondsRemaining: number) => void,
): Promise<boolean> {
  if (signal.aborted) return false;

  return new Promise<boolean>((resolve) => {
    let remaining = Math.ceil(ms / 1000);
    onTick?.(remaining);

    const finish = (completed: boolean) => {
      clearInterval(ticker);
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);

    const ticker = setInterval(() => {
      remaining = Math.max(0, remaining - 1);
      onTick?.(remaining);
    }, 1_000);
    const timer = setTimeout(() => finish(true), ms);

    signal.addEventListener("abort", onAbort);
  });
}
