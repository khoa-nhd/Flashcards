/**
 * Optional single-password gate. This is a personal app with one owner, so a
 * shared passphrase held in an httpOnly cookie is enough; anything stronger
 * belongs to the hosting platform (see README, "Keeping the app private").
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from './env.js';

export const SESSION_COOKIE = 'flashcard_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export type AccessMode = 'open' | 'password' | 'locked';

export function accessMode(config: AppConfig): AccessMode {
  if (config.accessPassword !== null) return 'password';
  // Without a password, only a local dev server or an explicit opt-out is open.
  if (!config.isProduction || config.allowUnauthenticated) return 'open';
  return 'locked';
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

export function passwordMatches(candidate: string, actual: string): boolean {
  // Hashing first gives equal-length buffers, which timingSafeEqual requires.
  return timingSafeEqual(sha256(candidate), sha256(actual));
}

function sign(expiresAt: number, password: string): string {
  // Keyed on the password, so changing it invalidates every issued session.
  return createHmac('sha256', sha256(`flashcard-session:${password}`))
    .update(String(expiresAt))
    .digest('base64url');
}

export function issueSessionToken(password: string, now: Date): string {
  const expiresAt = Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS;
  return `${expiresAt}.${sign(expiresAt, password)}`;
}

export function verifySessionToken(token: string | undefined, password: string, now: Date): boolean {
  if (!token) return false;
  const separator = token.indexOf('.');
  if (separator <= 0) return false;
  const expiresAt = Number(token.slice(0, separator));
  if (!Number.isInteger(expiresAt) || expiresAt * 1000 <= now.getTime()) return false;
  const provided = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(sign(expiresAt, password));
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Slows password guessing. Counts failures across all callers because client
 * addresses are unreliable behind proxies. It lives in memory, so it resets on
 * restart and is per-instance on serverless hosts — a strong passphrase is
 * still the real defence.
 */
export class LoginThrottle {
  private failures: number[] = [];

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 5 * 60 * 1000,
  ) {}

  /** Seconds until another attempt is allowed, or 0 when one is allowed now. */
  retryAfterSeconds(now: Date): number {
    const cutoff = now.getTime() - this.windowMs;
    this.failures = this.failures.filter((time) => time > cutoff);
    if (this.failures.length < this.maxFailures) return 0;
    const oldest = this.failures[0] ?? now.getTime();
    return Math.max(1, Math.ceil((oldest + this.windowMs - now.getTime()) / 1000));
  }

  recordFailure(now: Date): void {
    this.failures.push(now.getTime());
  }

  reset(): void {
    this.failures = [];
  }
}
