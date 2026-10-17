import type { AnalyticsService } from './analytics-service.js';
import type { ExportService } from './export-service.js';
import type { LibraryService } from './library-service.js';
import type { ReviewService } from './review-service.js';
import type { VocabularyService } from './vocabulary-service.js';
import type { AiService } from './ai-service-impl.js';

export interface Account {
  id: string;
  email: string | null;
}

/** Everything one request may do, bound to the account that made it and to nothing else. */
export interface AccountSession {
  account: Account;
  /** The zone that decides this account's "today". */
  timeZone: string;
  /** The database's schema version, and the newest one this server can use. */
  database: { version: number; latest: number };
  /** The retention FSRS aims for; `null` where the database cannot store it yet. */
  fsrsRetention: number | null;
  saveFsrsRetention(value: number): Promise<number>;
  /**
   * Whether a review moves a word by default. The reviewer chooses it beside
   * the words being reviewed; it is account-wide so the choice follows them.
   */
  countReviewsTowardMastery: boolean;
  saveCountReviewsTowardMastery(value: boolean): Promise<boolean>;
  review: ReviewService;
  vocabulary: VocabularyService;
  analytics: AnalyticsService;
  library: LibraryService;
  exporter: ExportService;
  /** `null` when AI chat is not configured. */
  ai: AiService | null;
  saveTimeZone(timeZone: string): Promise<string>;
}

export interface AccountGateway {
  /**
   * Opens a session for the bearer of this access token, or returns `null`
   * when the token is malformed, expired, or was not issued to a signed-in
   * user. `hints.timeZone` is only used to give a brand-new account a starting
   * zone; it never overrides a stored one.
   */
  open(accessToken: string, hints: { timeZone: string | null }): Promise<AccountSession | null>;
}

/** The token from an `Authorization: Bearer …` header, or `null`. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? '');
  const token = match?.[1] ?? null;
  // A JWT is three dot-separated parts; anything else is not worth a round trip.
  return token !== null && token.split('.').length === 3 && token.length <= 8192 ? token : null;
}
