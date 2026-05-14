/** One line from http_events.jsonl */
export interface RawHttpEvent {
  timestamp: string;
  method: string;
  host: string;
  path: string | null;
  status_code: number | null;
  bytes_out: number;
  bytes_in: number | null;
  source_app: string;
  tab_id: string | null;
  referrer: string | null;
  client_ip: string;
}

export interface EventRow {
  id: number;
  ts_ms: number;
  ts_utc: string;
  timestamp_raw: string;
  method: string;
  host: string;
  path: string | null;
  status_code: number | null;
  bytes_out: number;
  bytes_in: number | null;
  source_app: string;
  tab_id: string | null;
  referrer: string | null;
  client_ip: string;
}

export type ActivityClassification = "foreground" | "background" | "asset" | "unknown";

export interface ActivityEventRow {
  event_id: number;
  ts_ms: number;
  ts_utc: string;
  source_app: string;
  tab_id: string | null;
  host: string;
  path: string | null;
  canonical_host: string;
  activity_category: string;
  label_hint: string;
  classification: ActivityClassification;
  weight: number;
  reason: string;
}

export interface SessionSummary {
  foregroundEventCount: number;
  backgroundEventCount: number;
  topActivityCategories: [string, number][];
  topActivityHints: [string, number][];
  topHosts: [string, number][];
  topPaths: [string, number][];
  apps: [string, number][];
  background: {
    topHosts: [string, number][];
    topReasons: [string, number][];
  };
}
