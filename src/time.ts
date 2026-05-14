/**
 * Parse ISO 8601 timestamps (with offset or Z) to UTC epoch ms.
 * Uses the built-in parser so mixed `-07:00` and `Z` inputs stay comparable.
 */
export function parseTimestampToUtcMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid timestamp: ${iso}`);
  }
  return ms;
}

export function toIsoUtc(ms: number): string {
  return new Date(ms).toISOString();
}
