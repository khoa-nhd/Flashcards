import { APIErrorCode, APIResponseError, ClientErrorCode, isNotionClientError } from '@notionhq/client';
import { HttpError } from '../errors.js';

export type NotionFailure =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'validation'
  | 'conflict'
  | 'unavailable'
  | 'timeout'
  | 'unknown';

/** A Notion failure reduced to what the rest of the server needs to know. */
export class NotionRequestError extends Error {
  constructor(
    public readonly failure: NotionFailure,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'NotionRequestError';
  }
}

function retryAfter(headers: unknown): number | undefined {
  let raw: unknown;
  if (headers instanceof Headers) raw = headers.get('retry-after');
  else if (headers && typeof headers === 'object') raw = (headers as Record<string, unknown>)['retry-after'];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

export function toNotionRequestError(error: unknown): NotionRequestError {
  if (error instanceof NotionRequestError) return error;

  if (APIResponseError.isAPIResponseError(error)) {
    switch (error.code) {
      case APIErrorCode.Unauthorized:
        return new NotionRequestError('unauthorized', 'Notion rejected the integration token.');
      case APIErrorCode.RestrictedResource:
        return new NotionRequestError(
          'forbidden',
          'The Notion integration is not allowed to do this. Check its capabilities.',
        );
      case APIErrorCode.ObjectNotFound:
        return new NotionRequestError(
          'not_found',
          'Notion could not find that object. Check the id and that the database is shared with the integration.',
        );
      case APIErrorCode.RateLimited:
        return new NotionRequestError(
          'rate_limited',
          'Notion is rate limiting requests. Wait a moment and try again.',
          retryAfter(error.headers) ?? 2,
        );
      case APIErrorCode.ValidationError:
      case APIErrorCode.InvalidRequest:
      case APIErrorCode.InvalidRequestURL:
      case APIErrorCode.InvalidJSON:
        // Notion's validation text names the offending property, which is what the owner needs.
        return new NotionRequestError('validation', `Notion rejected the request: ${error.message}`);
      case APIErrorCode.ConflictError:
        return new NotionRequestError('conflict', 'Notion reported a save conflict. Try again.');
      case APIErrorCode.GatewayTimeout:
        return new NotionRequestError('timeout', 'Notion took too long to respond.');
      default:
        return new NotionRequestError('unavailable', 'Notion is temporarily unavailable.');
    }
  }

  if (isNotionClientError(error)) {
    if (error.code === ClientErrorCode.RequestTimeout) {
      return new NotionRequestError('timeout', 'Notion took too long to respond.');
    }
    return new NotionRequestError('unavailable', 'Notion returned an unexpected response.');
  }

  return new NotionRequestError('unknown', 'Could not reach Notion.');
}

const STATUS: Record<NotionFailure, { status: number; code: string }> = {
  unauthorized: { status: 502, code: 'notion_unauthorized' },
  forbidden: { status: 502, code: 'notion_forbidden' },
  not_found: { status: 502, code: 'notion_not_found' },
  rate_limited: { status: 429, code: 'rate_limited' },
  validation: { status: 502, code: 'notion_validation' },
  conflict: { status: 503, code: 'notion_conflict' },
  unavailable: { status: 502, code: 'notion_unavailable' },
  timeout: { status: 504, code: 'notion_timeout' },
  unknown: { status: 502, code: 'notion_unreachable' },
};

export function notionErrorToHttp(error: NotionRequestError): HttpError {
  const { status, code } = STATUS[error.failure];
  const headers =
    error.retryAfterSeconds !== undefined ? { 'Retry-After': String(error.retryAfterSeconds) } : undefined;
  return new HttpError(status, code, error.message, { headers });
}
