/** How discovery components turn a refusal into words the learner can act on. */
import { ApiError } from '../../lib/api-client.js';

/** True when the server has said saving is switched off for this account. */
export function isReadOnly(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'read_only';
}

/**
 * One sentence about a failure. An `ApiError` already carries a message
 * written for a person; anything else gets the caller's fallback so a
 * stack trace never reaches the screen.
 */
export function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'read_only') return 'Saving is switched off for this account, so nothing was changed.';
    return error.message;
  }
  return fallback;
}

/** The honest words for an AI suggestion that did not arrive. */
export function explainFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'not_supported') return 'This server has no AI assistance. Write the meaning yourself — nothing here needs AI.';
    if (error.code === 'read_only') return 'Saving is switched off, so no suggestion is offered. You can still read and mark.';
    if (error.code === 'rate_limited') return 'Too many AI asks just now. Wait a moment, or write the meaning yourself.';
    if (error.code === 'ai_invalid') return 'The model replied with something unusable. Try again, or write the meaning yourself.';
    if (error.status === 404) return 'That word is not in this text.';
    return `${error.message} You can write the meaning yourself.`;
  }
  return 'The suggestion could not be loaded. You can write the meaning yourself.';
}
