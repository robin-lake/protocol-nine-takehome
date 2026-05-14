import type { SqliteDatabase } from "./db.js";
import type { EventRow, SessionSummary } from "./types.js";

/** Idle gap between events that starts a new session (12 minutes). */
export const IDLE_GAP_MS = 12 * 60 * 1000;

/**
 * Maximum wall-clock span of a single session. Always-on apps can prevent
 * long idle gaps; this cap still yields multiple sessions over a day.
 */
export const MAX_SESSION_SPAN_MS = 3 * 60 * 60 * 1000;

/** Within a session, gaps longer than this between consecutive events break a "focus run". */
export const FOCUS_RUN_MAX_GAP_MS = 2 * 60 * 1000;

function contextKey(e: EventRow): string {
  return `${e.source_app}\t${e.tab_id ?? ""}`;
}

function buildSummary(events: EventRow[]): SessionSummary {
  const hostCounts = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  const appCounts = new Map<string, number>();
  for (const e of events) {
    hostCounts.set(e.host, (hostCounts.get(e.host) ?? 0) + 1);
    const p = e.path ?? "";
    pathCounts.set(p, (pathCounts.get(p) ?? 0) + 1);
    appCounts.set(e.source_app, (appCounts.get(e.source_app) ?? 0) + 1);
  }

  const top = (m: Map<string, number>, n: number): [string, number][] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  return {
    topHosts: top(hostCounts, 15),
    topPaths: top(pathCounts, 12),
    apps: top(appCounts, 10),
  };
}

/**
 * Focus: longest wall-clock span covered by a single (app, tab) context where
 * consecutive events in that run are at most FOCUS_RUN_MAX_GAP_MS apart.
 * Score = focus_run_ms / session_span_ms (0..1).
 */
function computeFocusScore(events: EventRow[]): number {
  if (events.length === 0) return 0;
  const spanMs = events[events.length - 1]!.ts_ms - events[0]!.ts_ms;
  if (spanMs <= 0) return 1;

  let bestRunMs = 0;
  let runStart = events[0]!.ts_ms;
  let runEnd = events[0]!.ts_ms;
  let runCtx = contextKey(events[0]!);

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]!;
    const cur = events[i]!;
    const gap = cur.ts_ms - prev.ts_ms;
    const ctx = contextKey(cur);
    if (ctx === runCtx && gap <= FOCUS_RUN_MAX_GAP_MS) {
      runEnd = cur.ts_ms;
    } else {
      bestRunMs = Math.max(bestRunMs, runEnd - runStart);
      runStart = cur.ts_ms;
      runEnd = cur.ts_ms;
      runCtx = ctx;
    }
  }
  bestRunMs = Math.max(bestRunMs, runEnd - runStart);
  return Math.min(1, bestRunMs / spanMs);
}

/**
 * Fragmentation: mix of app switching and host diversity (0..1, higher = more fragmented).
 */
function computeFragmentationScore(events: EventRow[]): number {
  const n = events.length;
  if (n <= 1) return 0;
  let appSwitches = 0;
  const hosts = new Set<string>();
  for (const e of events) hosts.add(e.host);
  for (let i = 1; i < n; i++) {
    if (events[i]!.source_app !== events[i - 1]!.source_app) appSwitches += 1;
  }
  const switchRate = appSwitches / (n - 1);
  const hostDiversity = Math.min(1, hosts.size / Math.max(8, Math.sqrt(n)));
  return Math.min(1, 0.55 * switchRate + 0.45 * hostDiversity);
}

export function rebuildSessions(db: SqliteDatabase): number {
  db.exec("DELETE FROM sessions");
  const rows = db
    .prepare(
      `SELECT id, ts_ms, ts_utc, timestamp_raw, method, host, path, status_code,
              bytes_out, bytes_in, source_app, tab_id, referrer, client_ip
       FROM events ORDER BY ts_ms ASC, id ASC`,
    )
    .all() as EventRow[];

  if (rows.length === 0) return 0;

  const sessions: EventRow[][] = [];
  let cur: EventRow[] = [rows[0]!];
  let sessionStartMs = rows[0]!.ts_ms;
  for (let i = 1; i < rows.length; i++) {
    const e = rows[i]!;
    const prev = cur[cur.length - 1]!;
    const gap = e.ts_ms - prev.ts_ms;
    const spanFromStart = e.ts_ms - sessionStartMs;
    if (gap > IDLE_GAP_MS || spanFromStart > MAX_SESSION_SPAN_MS) {
      sessions.push(cur);
      cur = [e];
      sessionStartMs = e.ts_ms;
    } else {
      cur.push(e);
    }
  }
  sessions.push(cur);

  const insert = db.prepare(`
    INSERT INTO sessions (
      start_ts_utc, end_ts_utc, start_ms, end_ms, duration_sec,
      event_count, unique_hosts, focus_score, fragmentation_score, summary_json
    ) VALUES (
      @start_ts_utc, @end_ts_utc, @start_ms, @end_ms, @duration_sec,
      @event_count, @unique_hosts, @focus_score, @fragmentation_score, @summary_json
    )
  `);

  const insertAll = db.transaction((chunks: EventRow[][]) => {
    for (const evs of chunks) {
      const start = evs[0]!;
      const end = evs[evs.length - 1]!;
      const spanMs = end.ts_ms - start.ts_ms;
      const durationSec = Math.max(1, spanMs / 1000);
      const hosts = new Set(evs.map((e) => e.host));
      const summary = buildSummary(evs);
      insert.run({
        start_ts_utc: start.ts_utc,
        end_ts_utc: end.ts_utc,
        start_ms: start.ts_ms,
        end_ms: end.ts_ms,
        duration_sec: durationSec,
        event_count: evs.length,
        unique_hosts: hosts.size,
        focus_score: computeFocusScore(evs),
        fragmentation_score: computeFragmentationScore(evs),
        summary_json: JSON.stringify(summary),
      });
    }
  });

  insertAll(sessions);
  return sessions.length;
}
