import "dotenv/config";
import Fastify from "fastify";
import { openDatabase } from "./db.js";
import { DEFAULT_DB_PATH } from "./paths.js";
import { computeTimeOnHosts } from "./insights.js";
import { labelAllPendingSessions } from "./llm.js";
import type { SessionSummary } from "./types.js";

function getDbPath(): string {
  return process.env.DB_PATH ?? DEFAULT_DB_PATH;
}

export function buildServer(dbPath: string) {
  const db = openDatabase(dbPath);
  const app = Fastify({ logger: true });

  app.addHook("onClose", async () => {
    db.close();
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/sessions", async () => {
    const rows = db
      .prepare(
        `SELECT id, start_ts_utc, end_ts_utc, start_ms, end_ms, duration_sec,
                event_count, unique_hosts, focus_score, fragmentation_score,
                summary_json, label, label_model, label_error, labeled_at
         FROM sessions ORDER BY start_ms ASC`,
      )
      .all();
    return { sessions: rows };
  });

  app.get("/sessions/extremes", async () => {
    const sessions = db
      .prepare(
        `SELECT id, start_ts_utc, end_ts_utc, duration_sec, event_count,
                focus_score, fragmentation_score, label
         FROM sessions`,
      )
      .all() as {
      id: number;
      start_ts_utc: string;
      end_ts_utc: string;
      duration_sec: number;
      event_count: number;
      focus_score: number;
      fragmentation_score: number;
      label: string | null;
    }[];

    if (sessions.length === 0) {
      return {
        most_sustained_focus: null,
        most_fragmented: null,
        definitions: {
          focus_score:
            "Longest single (source_app, tab_id) run with inter-event gaps ≤ 2m, divided by session span (0–1).",
          fragmentation_score:
            "Weighted mix of app-switch rate between consecutive events and unique-host diversity (0–1, higher = more fragmented).",
        },
      };
    }

    const byFocus = [...sessions].sort((a, b) => {
      if (b.focus_score !== a.focus_score) return b.focus_score - a.focus_score;
      return b.duration_sec - a.duration_sec;
    });
    const byFrag = [...sessions].sort((a, b) => {
      if (b.fragmentation_score !== a.fragmentation_score) return b.fragmentation_score - a.fragmentation_score;
      return b.event_count - a.event_count;
    });

    return {
      most_sustained_focus: byFocus[0] ?? null,
      most_fragmented: byFrag[0] ?? null,
      definitions: {
        focus_score:
          "Longest single (source_app, tab_id) run with inter-event gaps ≤ 2m, divided by session span (0–1).",
        fragmentation_score:
          "Weighted mix of app-switch rate between consecutive events and unique-host diversity (0–1, higher = more fragmented).",
      },
    };
  });

  app.get("/insights/time", async () => {
    const ranking = computeTimeOnHosts(db);
    return {
      metric:
        "Estimated seconds per host: each session's wall-clock span is allocated across hosts in proportion to raw HTTP event counts inside that session, then summed.",
      ranking,
    };
  });

  app.post("/sessions/label", async (request, reply) => {
    const body = (request.body ?? {}) as { limit?: number };
    try {
      const result = await labelAllPendingSessions(db, { limit: body.limit ?? 50 });
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      reply.code(400);
      return { error: message };
    }
  });

  app.get("/sessions/:id/summary", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id)) {
      reply.code(400);
      return { error: "invalid id" };
    }
    const row = db
      .prepare(
        `SELECT id, start_ts_utc, end_ts_utc, duration_sec, event_count, summary_json, label
         FROM sessions WHERE id = ?`,
      )
      .get(id) as
      | {
          id: number;
          start_ts_utc: string;
          end_ts_utc: string;
          duration_sec: number;
          event_count: number;
          summary_json: string;
          label: string | null;
        }
      | undefined;
    if (!row) {
      reply.code(404);
      return { error: "not found" };
    }
    return {
      ...row,
      summary: JSON.parse(row.summary_json) as SessionSummary,
    };
  });

  return app;
}

async function main(): Promise<void> {
  const dbPath = getDbPath();
  const app = buildServer(dbPath);
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
  app.log.info(`Listening on http://${host}:${port} (db: ${dbPath})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
