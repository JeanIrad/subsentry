import { LLMRateLimitError } from "@/lib/llm/types";

// Spaces out calls to a rate-limited API across all jobs in this process.
export interface Pacer {
  /**
   * Resolves when the next call may go out. Throws LLMRateLimitError instead
   * of sleeping when the wait is longer than `maxSleepMs` (e.g. a daily quota),
   * so the job can be rescheduled rather than held open for hours.
   */
  wait(): Promise<void>;
  /** The API said "slow down": hold every caller for at least this long. */
  pushBack(seconds: number): void;
}

export function createPacer(minIntervalMs: number, maxSleepMs = 120_000): Pacer {
  let nextSlot = 0;
  return {
    async wait() {
      const now = Date.now();
      const at = Math.max(now, nextSlot);
      if (at - now > maxSleepMs) throw new LLMRateLimitError(Math.ceil((at - now) / 1000));
      nextSlot = at + minIntervalMs;
      if (at > now) await new Promise((r) => setTimeout(r, at - now));
    },
    pushBack(seconds) {
      nextSlot = Math.max(nextSlot, Date.now() + seconds * 1000);
    },
  };
}
