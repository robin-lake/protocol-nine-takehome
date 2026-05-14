import type { SqliteDatabase } from "./db.js";

interface ActivityObservationRow {
  id: number;
  ts_ms: number;
  activity_category: string;
  label_hint: string;
  weight: number;
}

interface TimeWindow {
  fromMs?: number;
  toMs?: number;
}

/**
 * Estimate active attention time from foreground-weighted observations.
 * Each observation receives the bounded dwell time until the next foreground
 * observation in the same session, grouped by human-ish activity category.
 */
export function computeTimeOnActivities(
  db: SqliteDatabase,
  window: TimeWindow = {},
): {
  activity: string;
  label_hint: string;
  estimated_seconds: number;
  share: number;
}[] {
  const params: number[] = [];
  let sql = `SELECT s.id AS id, ae.ts_ms AS ts_ms, ae.activity_category AS activity_category,
                    ae.label_hint AS label_hint, ae.weight AS weight
             FROM sessions s
             JOIN activity_events ae ON ae.ts_ms >= s.start_ms AND ae.ts_ms <= s.end_ms
             WHERE ae.classification IN ('foreground', 'unknown') AND ae.weight >= 0.25`;
  if (window.fromMs !== undefined) {
    sql += " AND ae.ts_ms >= ?";
    params.push(window.fromMs);
  }
  if (window.toMs !== undefined) {
    sql += " AND ae.ts_ms <= ?";
    params.push(window.toMs);
  }
  sql += " ORDER BY s.id ASC, ae.ts_ms ASC, ae.event_id ASC";

  const rows = db
    .prepare(sql)
    .all(...params) as ActivityObservationRow[];

  const perSession = new Map<number, ActivityObservationRow[]>();
  for (const r of rows) {
    const slot = perSession.get(r.id) ?? [];
    slot.push(r);
    perSession.set(r.id, slot);
  }

  const totals = new Map<string, { seconds: number; hints: Map<string, number> }>();
  for (const events of perSession.values()) {
    for (let i = 0; i < events.length; i++) {
      const cur = events[i]!;
      const next = events[i + 1];
      const dwellSec = next ? Math.min(Math.max(0, next.ts_ms - cur.ts_ms), 10 * 60 * 1000) / 1000 : 60;
      const weightedSec = dwellSec * cur.weight;
      const slot = totals.get(cur.activity_category) ?? { seconds: 0, hints: new Map() };
      slot.seconds += weightedSec;
      slot.hints.set(cur.label_hint, (slot.hints.get(cur.label_hint) ?? 0) + weightedSec);
      totals.set(cur.activity_category, slot);
    }
  }

  const grand = [...totals.values()].reduce((a, b) => a + b.seconds, 0) || 1;
  return [...totals.entries()]
    .map(([activity, { seconds, hints }]) => ({
      activity,
      label_hint: [...hints.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? activity,
      estimated_seconds: Math.round(seconds * 10) / 10,
      share: Math.round((seconds / grand) * 1000) / 1000,
    }))
    .sort((a, b) => b.estimated_seconds - a.estimated_seconds);
}
