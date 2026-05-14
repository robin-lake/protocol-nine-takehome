import type { SqliteDatabase } from "./db.js";
import type { ActivityEventRow, SessionSummary } from "./types.js";

/** Idle gap between foreground observations that starts a new activity session. */
export const IDLE_GAP_MS = 20 * 60 * 1000;

/** Large gap after an activity-category switch that likely indicates a new task. */
export const TOPIC_SWITCH_GAP_MS = 8 * 60 * 1000;

/** Guardrail so dense foreground streams do not collapse a whole day into one session. */
export const MAX_SESSION_ACTIVE_SPAN_MS = 2 * 60 * 60 * 1000;

/**
 * Maximum dwell time attributed from one foreground observation to the next.
 * This prevents one page request from claiming hours of attention.
 */
export const MAX_DWELL_MS = 10 * 60 * 1000;

/** Within a session, gaps longer than this between consecutive events break a "focus run". */
export const FOCUS_RUN_MAX_GAP_MS = 10 * 60 * 1000;

const MIN_ACTIVE_WEIGHT = 0.25;
const SINGLE_OBSERVATION_SECONDS = 60;

function contextKey(e: ActivityEventRow): string {
  return e.tab_id ? `${e.source_app}\t${e.tab_id}` : e.activity_category;
}

function addWeighted(map: Map<string, number>, key: string, weight: number): void {
  map.set(key, (map.get(key) ?? 0) + weight);
}

function top(m: Map<string, number>, n: number): [string, number][] {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => [k, Math.round(v * 10) / 10]);
}

function buildSummary(activeEvents: ActivityEventRow[], allEvents: ActivityEventRow[]): SessionSummary {
  const categoryWeights = new Map<string, number>();
  const hintWeights = new Map<string, number>();
  const hostWeights = new Map<string, number>();
  const pathWeights = new Map<string, number>();
  const appWeights = new Map<string, number>();
  for (const e of activeEvents) {
    addWeighted(categoryWeights, e.activity_category, e.weight);
    addWeighted(hintWeights, e.label_hint, e.weight);
    addWeighted(hostWeights, e.canonical_host, e.weight);
    const p = e.path ?? "";
    addWeighted(pathWeights, p, e.weight);
    addWeighted(appWeights, e.source_app, e.weight);
  }

  const backgroundHosts = new Map<string, number>();
  const backgroundReasons = new Map<string, number>();
  let backgroundEventCount = 0;
  for (const e of allEvents) {
    if (e.classification === "background" || e.classification === "asset") {
      backgroundEventCount += 1;
      addWeighted(backgroundHosts, e.canonical_host, 1);
      addWeighted(backgroundReasons, e.reason, 1);
    }
  }

  return {
    foregroundEventCount: activeEvents.length,
    backgroundEventCount,
    topActivityCategories: top(categoryWeights, 10),
    topActivityHints: top(hintWeights, 12),
    topHosts: top(hostWeights, 15),
    topPaths: top(pathWeights, 12),
    apps: top(appWeights, 10),
    background: {
      topHosts: top(backgroundHosts, 10),
      topReasons: top(backgroundReasons, 10),
    },
  };
}

function activeRows(rows: ActivityEventRow[]): ActivityEventRow[] {
  return rows.filter(
    (e) => (e.classification === "foreground" || e.classification === "unknown") && e.weight >= MIN_ACTIVE_WEIGHT,
  );
}

function estimateDurationSec(events: ActivityEventRow[]): number {
  if (events.length <= 1) return SINGLE_OBSERVATION_SECONDS;
  let totalMs = 0;
  for (let i = 0; i < events.length - 1; i++) {
    const gap = events[i + 1]!.ts_ms - events[i]!.ts_ms;
    totalMs += Math.max(0, Math.min(gap, MAX_DWELL_MS));
  }
  return Math.max(SINGLE_OBSERVATION_SECONDS, totalMs / 1000);
}

/**
 * Focus: longest estimated active span covered by one tab/app/category context.
 * Score = focus_run_ms / estimated_active_ms (0..1).
 */
function computeFocusScore(events: ActivityEventRow[], durationSec: number): number {
  if (events.length === 0) return 0;
  if (events.length === 1) return 1;

  let bestRunMs = 0;
  let runCtx = contextKey(events[0]!);
  let runMs = 0;

  for (let i = 0; i < events.length - 1; i++) {
    const prev = events[i]!;
    const cur = events[i + 1]!;
    const gap = cur.ts_ms - prev.ts_ms;
    const stepMs = Math.max(0, Math.min(gap, MAX_DWELL_MS));
    const nextCtx = contextKey(cur);
    if (contextKey(prev) === runCtx && nextCtx === runCtx && gap <= FOCUS_RUN_MAX_GAP_MS) {
      runMs += stepMs;
    } else {
      bestRunMs = Math.max(bestRunMs, runMs);
      runCtx = nextCtx;
      runMs = 0;
    }
  }
  bestRunMs = Math.max(bestRunMs, runMs);
  return Math.min(1, bestRunMs / Math.max(1, durationSec * 1000));
}

/**
 * Fragmentation: mix of activity switching and foreground host diversity (0..1, higher = more fragmented).
 */
function computeFragmentationScore(events: ActivityEventRow[]): number {
  const n = events.length;
  if (n <= 1) return 0;
  let categorySwitches = 0;
  const hosts = new Set<string>();
  for (const e of events) hosts.add(e.canonical_host);
  for (let i = 1; i < n; i++) {
    if (events[i]!.activity_category !== events[i - 1]!.activity_category) categorySwitches += 1;
  }
  const switchRate = categorySwitches / (n - 1);
  const hostDiversity = Math.min(1, hosts.size / Math.max(8, Math.sqrt(n)));
  return Math.min(1, 0.55 * switchRate + 0.45 * hostDiversity);
}

export function rebuildSessions(db: SqliteDatabase): number {
  db.exec("DELETE FROM sessions");
  const active = db
    .prepare(
      `SELECT event_id, ts_ms, ts_utc, source_app, tab_id, host, path, canonical_host,
              activity_category, label_hint, classification, weight, reason
       FROM activity_events
       WHERE classification IN ('foreground', 'unknown') AND weight >= ?
       ORDER BY ts_ms ASC, event_id ASC`,
    )
    .all(MIN_ACTIVE_WEIGHT) as ActivityEventRow[];

  if (active.length === 0) return 0;

  const sessions: ActivityEventRow[][] = [];
  let cur: ActivityEventRow[] = [active[0]!];
  for (let i = 1; i < active.length; i++) {
    const e = active[i]!;
    const prev = cur[cur.length - 1]!;
    const gap = e.ts_ms - prev.ts_ms;
    const spanFromStart = e.ts_ms - cur[0]!.ts_ms;
    const topicSwitched = e.activity_category !== prev.activity_category;
    if (gap > IDLE_GAP_MS || (topicSwitched && gap > TOPIC_SWITCH_GAP_MS) || spanFromStart > MAX_SESSION_ACTIVE_SPAN_MS) {
      sessions.push(cur);
      cur = [e];
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

  const allInWindow = db.prepare(
    `SELECT event_id, ts_ms, ts_utc, source_app, tab_id, host, path, canonical_host,
            activity_category, label_hint, classification, weight, reason
     FROM activity_events
     WHERE ts_ms >= ? AND ts_ms <= ?
     ORDER BY ts_ms ASC, event_id ASC`,
  );

  const insertAll = db.transaction((chunks: ActivityEventRow[][]) => {
    for (const rawEvs of chunks) {
      const evs = activeRows(rawEvs);
      if (evs.length === 0) continue;
      const start = evs[0]!;
      const end = evs[evs.length - 1]!;
      const durationSec = estimateDurationSec(evs);
      const hosts = new Set(evs.map((e) => e.canonical_host));
      const allEvents = allInWindow.all(start.ts_ms, end.ts_ms) as ActivityEventRow[];
      const summary = buildSummary(evs, allEvents);
      insert.run({
        start_ts_utc: start.ts_utc,
        end_ts_utc: end.ts_utc,
        start_ms: start.ts_ms,
        end_ms: end.ts_ms,
        duration_sec: durationSec,
        event_count: evs.length,
        unique_hosts: hosts.size,
        focus_score: computeFocusScore(evs, durationSec),
        fragmentation_score: computeFragmentationScore(evs),
        summary_json: JSON.stringify(summary),
      });
    }
  });

  insertAll(sessions);
  return sessions.length;
}
