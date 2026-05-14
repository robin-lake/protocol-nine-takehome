# HTTP Activity API

Base URL: `http://localhost:3000` (override with `PORT` / `HOST`). All responses are JSON.

## Prerequisites

Run ingestion first so SQLite is populated:

```bash
npm run ingest
```

## `GET /health`

Liveness check.

**200** — `{ "ok": true }`

## `GET /sessions`

Distinct activity sessions for the ingested period.

**200** — `{ "sessions": Session[] }`

Each `Session` row includes: `id`, `start_ts_utc`, `end_ts_utc`, `start_ms`, `end_ms`, `duration_sec`, `event_count`, `unique_hosts`, `focus_score`, `fragmentation_score`, `summary_json` (stringified rollups), optional `label`, `label_model`, `label_error`, `labeled_at`.

## `GET /sessions/extremes`

Answers: which session had the most sustained focus, and which was most fragmented.

**200** —

```json
{
  "most_sustained_focus": { "...session fields..." } | null,
  "most_fragmented": { "...session fields..." } | null,
  "definitions": {
    "focus_score": "...",
    "fragmentation_score": "..."
  }
}
```

Tie-breakers: higher `duration_sec` for focus; higher `event_count` for fragmentation.

## `GET /insights/time`

Answers: what the user spent the most time on (under the documented attribution model).

**200** —

```json
{
  "metric": "…human-readable definition…",
  "ranking": [
    { "host": "example.com", "estimated_seconds": 123.4, "share": 0.21 }
  ]
}
```

## `GET /sessions/:id/summary`

Returns one session with `summary` parsed from `summary_json` (top hosts/paths/apps).

**404** — `{ "error": "not found" }`

## `POST /sessions/label`

Runs the LLM labeler for up to `limit` sessions missing `label` (default 50). Requires `OPENAI_API_KEY`.

**Body (optional JSON):** `{ "limit": 20 }`

**200** — `{ "labeled": number, "errors": number }`

**400** — `{ "error": "OPENAI_API_KEY is not set" }` (or other configuration/runtime errors).

## Example `curl` commands

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/sessions | jq '.sessions | length'
curl -s http://localhost:3000/sessions/extremes | jq .
curl -s http://localhost:3000/insights/time | jq '.ranking[:10]'
curl -s http://localhost:3000/sessions/1/summary | jq .
curl -s -X POST http://localhost:3000/sessions/label -H 'content-type: application/json' -d '{"limit":10}'
```
