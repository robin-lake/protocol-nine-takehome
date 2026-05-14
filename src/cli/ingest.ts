import { readFileSync } from "node:fs";
import { openDatabase, type SqliteDatabase } from "../db.js";
import { DEFAULT_DB_PATH, DEFAULT_JSONL_PATH } from "../paths.js";
import { parseTimestampToUtcMs, toIsoUtc } from "../time.js";
import type { RawHttpEvent } from "../types.js";
import { rebuildActivityEvents } from "../activity.js";
import { rebuildSessions } from "../sessionize.js";

function dedupeKey(tsMs: number, method: string, host: string, path: string | null): string {
  return `${tsMs}|${method}|${host}|${path ?? ""}`;
}

export function ingestFromJsonl(
  db: SqliteDatabase,
  jsonlPath: string,
  options: { clear?: boolean } = {},
): { inserted: number; skipped: number; lines: number } {
  const clear = options.clear ?? true;
  if (clear) {
    db.exec("DELETE FROM sessions");
    db.exec("DELETE FROM activity_events");
    db.exec("DELETE FROM events");
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      ts_ms, ts_utc, timestamp_raw, method, host, path, status_code,
      bytes_out, bytes_in, source_app, tab_id, referrer, client_ip, dedupe_key
    ) VALUES (
      @ts_ms, @ts_utc, @timestamp_raw, @method, @host, @path, @status_code,
      @bytes_out, @bytes_in, @source_app, @tab_id, @referrer, @client_ip, @dedupe_key
    )
  `);

  const text = readFileSync(jsonlPath, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  let inserted = 0;
  let skipped = 0;

  const insertMany = db.transaction((rows: RawHttpEvent[]) => {
    for (const raw of rows) {
      const tsMs = parseTimestampToUtcMs(raw.timestamp);
      const host = raw.host ?? "";
      const method = raw.method ?? "UNKNOWN";
      const sourceApp = raw.source_app ?? "unknown";
      const clientIp = raw.client_ip ?? "";
      const key = dedupeKey(tsMs, method, host, raw.path);
      const info = insert.run({
        ts_ms: tsMs,
        ts_utc: toIsoUtc(tsMs),
        timestamp_raw: raw.timestamp,
        method,
        host,
        path: raw.path,
        status_code: raw.status_code,
        bytes_out: raw.bytes_out ?? 0,
        bytes_in: raw.bytes_in,
        source_app: sourceApp,
        tab_id: raw.tab_id,
        referrer: raw.referrer,
        client_ip: clientIp,
        dedupe_key: key,
      });
      if (info.changes > 0) inserted += 1;
      else skipped += 1;
    }
  });

  const parsed: RawHttpEvent[] = [];
  for (const line of lines) {
    parsed.push(JSON.parse(line) as RawHttpEvent);
  }
  insertMany(parsed);

  rebuildActivityEvents(db);
  rebuildSessions(db);
  return { inserted, skipped, lines: lines.length };
}

function main(): void {
  const jsonl = process.argv[2] ?? DEFAULT_JSONL_PATH;
  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  const db = openDatabase(dbPath);
  const { inserted, skipped, lines } = ingestFromJsonl(db, jsonl);
  console.log(`Ingested JSONL: ${jsonl}`);
  console.log(`Lines: ${lines}, inserted: ${inserted}, duplicate/skipped: ${skipped}`);
  console.log(`Database: ${dbPath}`);
  db.close();
}

main();
