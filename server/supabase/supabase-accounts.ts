/**
 * Turns a Supabase access token into a session that can only reach that
 * account's rows. The token is verified here first, and then used as the
 * credential for every query, so the database enforces the same boundary
 * again through Row Level Security.
 */
import { createClient, isAuthRetryableFetchError } from '@supabase/supabase-js';
import { isValidTimeZone } from '../../shared/dates.js';
import type { ReviewRules } from '../../shared/review-logic.js';
import type { CardFieldConfig, NewWordDefaults } from '../../shared/vocabulary.js';
import type { Account, AccountGateway } from '../accounts.js';
import { ReviewService } from '../review-service.js';
import { VocabularyService } from '../vocabulary-service.js';
import {
  DatabaseError,
  createSupabaseDatabase,
  createUserClient,
  type VocabularyDatabase,
} from './supabase-database.js';
import { SupabaseVocabularyRepository } from './supabase-repository.js';

export interface TokenVerifier {
  /** The account the token belongs to, or `null` if it is not a valid user token. */
  verify(accessToken: string): Promise<Account | null>;
}

/** What a verified token says about its bearer. Only these claims are relied on. */
export function accountFromClaims(claims: Record<string, unknown>): Account | null {
  const { sub, role, email } = claims;
  // `anon` is the public key itself; `service_role` is never a person. Neither is an account.
  if (role !== 'authenticated') return null;
  if (typeof sub !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sub)) {
    return null;
  }
  return { id: sub.toLowerCase(), email: typeof email === 'string' && email !== '' ? email : null };
}

/**
 * Verifies tokens against the project's own signing keys (fetched once and
 * cached by the SDK), or by asking the Auth server when the project still
 * signs with a shared secret.
 */
export function createSupabaseVerifier(url: string, publicKey: string, fetchImpl?: typeof fetch): TokenVerifier {
  const client = createClient(url, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(fetchImpl === undefined ? {} : { global: { fetch: fetchImpl } }),
  });

  // Not being able to check is different from a bad token: say so, rather than sign the user out.
  const unreachable = () => new DatabaseError('unavailable', 'The sign-in service is temporarily unavailable.');

  return {
    async verify(accessToken) {
      let result: Awaited<ReturnType<typeof client.auth.getClaims>>;
      try {
        result = await client.auth.getClaims(accessToken);
      } catch (error) {
        if (isAuthRetryableFetchError(error)) throw unreachable();
        // The SDK throws, rather than returns, when a token cannot even be decoded. That is simply a bad token.
        return null;
      }
      if (result.error) {
        if (isAuthRetryableFetchError(result.error)) throw unreachable();
        return null;
      }
      return result.data === null ? null : accountFromClaims(result.data.claims);
    },
  };
}

export interface SupabaseAccountsOptions {
  url: string;
  publicKey: string;
  rules: ReviewRules;
  cardFields: readonly CardFieldConfig[];
  defaults: NewWordDefaults;
  /** The zone a new account starts with when the browser does not offer a usable one. */
  defaultTimeZone: string | null;
  writesRequested: boolean;
  verifier?: TokenVerifier;
  /** Opens the database as the bearer of this token. Replaceable in tests. */
  connect?: (accessToken: string) => VocabularyDatabase;
  now?: () => Date;
}

const FALLBACK_TIME_ZONE = 'UTC';

export function createSupabaseAccounts(options: SupabaseAccountsOptions): AccountGateway {
  const { url, publicKey, rules, cardFields, defaults, defaultTimeZone, writesRequested, now } = options;
  const verifier = options.verifier ?? createSupabaseVerifier(url, publicKey);
  const connect =
    options.connect ?? ((accessToken) => createSupabaseDatabase(createUserClient(url, publicKey, accessToken)));

  return {
    async open(accessToken, hints) {
      const account = await verifier.verify(accessToken);
      if (account === null) return null;

      // Built per request and never shared: nothing here can outlive, or leak into, another account's request.
      const database = connect(accessToken);

      let timeZone = await database.getTimeZone();
      if (timeZone === null) {
        const hinted = hints.timeZone !== null && isValidTimeZone(hints.timeZone) ? hints.timeZone : null;
        timeZone = await database.ensureTimeZone(hinted ?? defaultTimeZone ?? FALLBACK_TIME_ZONE);
      }
      if (!isValidTimeZone(timeZone)) timeZone = FALLBACK_TIME_ZONE;

      const repository = new SupabaseVocabularyRepository(database, rules);
      return {
        account,
        timeZone,
        review: new ReviewService({ repository, rules, cardFields, timeZone, writesRequested, now }),
        vocabulary: new VocabularyService({ catalog: repository, rules, defaults, timeZone, writesRequested, now }),
        async saveTimeZone(next) {
          if (!isValidTimeZone(next)) throw new DatabaseError('invalid', 'That is not a time zone this app recognises.');
          return database.saveTimeZone(next);
        },
      };
    },
  };
}
