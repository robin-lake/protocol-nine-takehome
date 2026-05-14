import type { SqliteDatabase } from "./db.js";

interface HostCountRow {
  id: number;
  duration_sec: number;
  host: string;
  cnt: number;
}

/**
 * Allocate each session's wall-clock span across hosts in proportion to
 * event counts inside that session, then sum by host globally.
 */
export function computeTimeOnHosts(db: SqliteDatabase): {
  host: string;
  estimated_seconds: number;
  share: number;
}[] {
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.duration_sec AS duration_sec, e.host AS host, COUNT(*) AS cnt
       FROM sessions s
       JOIN events e ON e.ts_ms >= s.start_ms AND e.ts_ms <= s.end_ms
       GROUP BY s.id, s.duration_sec, e.host`,
    )
    .all() as HostCountRow[];

  const perSession = new Map<number, { duration: number; counts: Map<string, number> }>();
  for (const r of rows) {
    let slot = perSession.get(r.id);
    if (!slot) {
      slot = { duration: r.duration_sec, counts: new Map() };
      perSession.set(r.id, slot);
    }
    slot.counts.set(r.host, (slot.counts.get(r.host) ?? 0) + r.cnt);
  }

  const totals = new Map<string, number>();
  for (const { duration, counts } of perSession.values()) {
    let sum = 0;
    for (const c of counts.values()) sum += c;
    if (sum === 0) continue;
    for (const [host, c] of counts) {
      totals.set(host, (totals.get(host) ?? 0) + duration * (c / sum));
    }
  }

  const grand = [...totals.values()].reduce((a, b) => a + b, 0) || 1;
  return [...totals.entries()]
    .map(([host, estimated_seconds]) => ({
      host,
      estimated_seconds: Math.round(estimated_seconds * 10) / 10,
      share: Math.round((estimated_seconds / grand) * 1000) / 1000,
    }))
    .sort((a, b) => b.estimated_seconds - a.estimated_seconds);
}
