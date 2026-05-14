import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqliteDatabase = InstanceType<typeof Database>;

export const SCHEMA_VERSION = 1;

export const DDL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  ts_utc TEXT NOT NULL,
  timestamp_raw TEXT NOT NULL,
  method TEXT NOT NULL,
  host TEXT NOT NULL,
  path TEXT,
  status_code INTEGER,
  bytes_out INTEGER NOT NULL,
  bytes_in INTEGER,
  source_app TEXT NOT NULL,
  tab_id TEXT,
  referrer TEXT,
  client_ip TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts_ms);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts_utc TEXT NOT NULL,
  end_ts_utc TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  duration_sec REAL NOT NULL,
  event_count INTEGER NOT NULL,
  unique_hosts INTEGER NOT NULL,
  focus_score REAL NOT NULL,
  fragmentation_score REAL NOT NULL,
  summary_json TEXT NOT NULL,
  label TEXT,
  label_model TEXT,
  label_error TEXT,
  labeled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start_ms);
`;

export function openDatabase(dbPath: string): SqliteDatabase {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(DDL);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  return db;
}
