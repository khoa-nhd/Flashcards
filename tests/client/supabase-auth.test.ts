import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { toAuthFailure } from '../../src/lib/supabase-auth.js';

describe('toAuthFailure', () => {
  it.each([
    ['invalid_credentials', 400, 'invalid_credentials'],
    ['email_not_confirmed', 400, 'email_not_confirmed'],
    ['weak_password', 422, 'weak_password'],
    ['same_password', 422, 'weak_password'],
    ['user_already_exists', 422, 'already_registered'],
    ['email_exists', 422, 'already_registered'],
    ['email_address_invalid', 400, 'invalid_email'],
    ['signup_disabled', 422, 'signups_disabled'],
    ['over_email_send_rate_limit', 429, 'rate_limited'],
    ['over_request_rate_limit', 429, 'rate_limited'],
    ['unexpected_failure', 500, 'unknown'],
  ] as const)('maps the provider’s %s to %s', (code, status, expected) => {
    expect(toAuthFailure(new AuthApiError('Provider wording that is not shown.', status, code)).code).toBe(expected);
  });

  it('recognises a rate limit by its status alone', () => {
    expect(toAuthFailure(new AuthApiError('Too many requests', 429, undefined)).code).toBe('rate_limited');
  });

  it('tells a connection problem apart from a refused sign-in', () => {
    const failure = toAuthFailure(new AuthRetryableFetchError('Failed to fetch', 0));
    expect(failure.code).toBe('network');
    expect(failure.message).toContain('Check your connection');
  });

  it('uses its own wording, never the provider’s', () => {
    const failure = toAuthFailure(new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'));
    expect(failure.message).toBe('That email and password do not match an account.');
    expect(toAuthFailure('not even an error').code).toBe('unknown');
    expect(toAuthFailure(null).code).toBe('unknown');
  });
});
