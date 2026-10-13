/**
 * A small per-account limit on how often the language model may be asked
 * anything. Free tiers run out quickly, and a runaway loop in the interface
 * should cost a few seconds of waiting rather than the whole quota — so the
 * limit is checked here, before any request is made.
 *
 * A token bucket: each account holds up to `capacity` requests and earns one
 * back every `refillMs`. Nothing is stored beyond this process, which is all
 * a serverless instance can promise anyway.
 */

export interface RateLimiter {
  /** Whether one more call may be made for this account right now. */
  allow(key: string, now?: number): boolean;
}

export interface TokenBucketOptions {
  capacity: number;
  /** How long one token takes to earn back, in milliseconds. */
  refillMs: number;
}

export function createTokenBucket({ capacity, refillMs }: TokenBucketOptions): RateLimiter {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    allow(key, now = Date.now()) {
      const bucket = buckets.get(key) ?? { tokens: capacity, at: now };
      // Earned tokens for the time passed, capped at the capacity.
      const earned = Math.floor((now - bucket.at) / refillMs);
      if (earned > 0) {
        bucket.tokens = Math.min(capacity, bucket.tokens + earned);
        bucket.at = now;
      }
      if (bucket.tokens <= 0) {
        buckets.set(key, bucket);
        return false;
      }
      bucket.tokens -= 1;
      buckets.set(key, bucket);
      return true;
    },
  };
}
