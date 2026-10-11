/** "1 min 05 s", or "42 s" under a minute. */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds} s` : `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
}

/** "3 words", "1 word". */
export function count(amount: number, one: string, many = `${one}s`): string {
  return `${amount} ${amount === 1 ? one : many}`;
}
