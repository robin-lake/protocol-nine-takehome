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

export interface SessionSummary {
  topHosts: [string, number][];
  topPaths: [string, number][];
  apps: [string, number][];
}
