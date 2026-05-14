import "dotenv/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { openDatabase } from "./db.js";
import { DEFAULT_DB_PATH } from "./paths.js";
import { computeTimeOnActivities } from "./insights.js";
import { labelAllPendingSessions } from "./llm.js";
import type { SessionSummary } from "./types.js";

const OPENAPI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "openapi.yaml");

function getDbPath(): string {
  return process.env.DB_PATH ?? DEFAULT_DB_PATH;
}

/** Parse optional query `from` / `to` as ISO 8601 (same family as `Date.parse` on events). */
function parseOptionalIsoInstant(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (s === "") return undefined;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new Error("Invalid `from` or `to`: expected ISO 8601 date-time");
  }
  return ms;
}

function parseTimeWindow(
  query: { from?: string; to?: string },
  reply: { code: (statusCode: number) => unknown },
): { ok: true; fromMs?: number; toMs?: number } | { ok: false; error: { error: string } } {
  let fromMs: number | undefined;
  let toMs: number | undefined;
  try {
    fromMs = parseOptionalIsoInstant(query.from);
    toMs = parseOptionalIsoInstant(query.to);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reply.code(400);
    return { ok: false, error: { error: message } };
  }
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    reply.code(400);
    return { ok: false, error: { error: "`from` must be less than or equal to `to`" } };
  }
  return { ok: true, fromMs, toMs };
}

export async function buildServer(dbPath: string) {
  const db = openDatabase(dbPath);
  const app = Fastify({ logger: true });

  await app.register(fastifySwagger, {
    mode: "static",
    specification: {
      path: OPENAPI_PATH,
      baseDir: dirname(OPENAPI_PATH),
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });

  app.addHook("onClose", async () => {
    db.close();
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/sessions", async (request, reply) => {
    const window = parseTimeWindow(request.query as { from?: string; to?: string }, reply);
    if (!window.ok) return window.error;

    const base = `SELECT id, start_ts_utc, end_ts_utc, start_ms, end_ms, duration_sec,
                event_count, unique_hosts, focus_score, fragmentation_score,
                summary_json, label, label_model, label_error, labeled_at
         FROM sessions`;
    let sql = `${base} WHERE 1=1`;
    const params: number[] = [];
    if (window.fromMs !== undefined && window.toMs !== undefined) {
      sql += " AND start_ms <= ? AND end_ms >= ?";
      params.push(window.toMs, window.fromMs);
    } else if (window.fromMs !== undefined) {
      sql += " AND end_ms >= ?";
      params.push(window.fromMs);
    } else if (window.toMs !== undefined) {
      sql += " AND start_ms <= ?";
      params.push(window.toMs);
    }
    sql += " ORDER BY start_ms ASC";

    const rows = db.prepare(sql).all(...params);
    return { sessions: rows };
  });

  app.get("/sessions/extremes", async (request, reply) => {
    const window = parseTimeWindow(request.query as { from?: string; to?: string }, reply);
    if (!window.ok) return window.error;

    let sql = `SELECT id, start_ts_utc, end_ts_utc, duration_sec, event_count,
                      focus_score, fragmentation_score, label
               FROM sessions
               WHERE 1=1`;
    const params: number[] = [];
    if (window.fromMs !== undefined && window.toMs !== undefined) {
      sql += " AND start_ms <= ? AND end_ms >= ?";
      params.push(window.toMs, window.fromMs);
    } else if (window.fromMs !== undefined) {
      sql += " AND end_ms >= ?";
      params.push(window.fromMs);
    } else if (window.toMs !== undefined) {
      sql += " AND start_ms <= ?";
      params.push(window.toMs);
    }

    const sessions = db
      .prepare(sql)
      .all(...params) as {
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
            "Longest single tab/app/category run over foreground-weighted observations, divided by estimated active time (0–1).",
          fragmentation_score:
            "Weighted mix of activity-category switching and foreground host diversity (0–1, higher = more fragmented).",
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
          "Longest single tab/app/category run over foreground-weighted observations, divided by estimated active time (0–1).",
        fragmentation_score:
          "Weighted mix of activity-category switching and foreground host diversity (0–1, higher = more fragmented).",
      },
    };
  });

  app.get("/insights/time", async (request, reply) => {
    const window = parseTimeWindow(request.query as { from?: string; to?: string }, reply);
    if (!window.ok) return window.error;

    const ranking = computeTimeOnActivities(db, { fromMs: window.fromMs, toMs: window.toMs });
    return {
      metric:
        "Estimated active seconds per activity: foreground/unknown observations receive bounded dwell time until the next observation; background sync, telemetry, and static assets are excluded.",
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
  const app = await buildServer(dbPath);
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
  app.log.info(`Listening on http://${host}:${port} (db: ${dbPath})`);
  app.log.info(`Swagger UI: http://${host === "0.0.0.0" ? "localhost" : host}:${port}/docs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
