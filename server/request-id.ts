import { createHash } from 'node:crypto';

/**
 * A request id for one part of a larger submission, worked out from the
 * submission's own id and where the part sat in it. The same file imported
 * twice therefore derives the same ids, and the request-id uniqueness on each
 * table lands a retry on the records already made instead of making them
 * again — or the ones an interrupted run never reached, which it makes now.
 */
export function derivedRequestId(parent: string, label: string): string {
  const digest = createHash('sha1').update(`${parent}:${label}`).digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50; // uuid version 5
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
