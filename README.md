# HTTP Activity Intelligence (take-home)

Turn `http_events.jsonl` into SQLite-backed **foreground-weighted sessions**, a small **Fastify** API, optional **OpenAI** session labels, and **Swagger UI** over **OpenAPI 3.1** spec.

**Further reading:** [DESIGN.md](DESIGN.md) (design doc). [AI_NOTES.md](AI_NOTES.md) (how AI tools were used).

## Prerequisites

- **Node.js 20.x** — see `.nvmrc` and `package.json` `engines`.
- **`http_events.jsonl`** at the repository root (provided for the exercise).

## Install and config

```bash
nvm use          # if you use nvm
npm install
cp .env.example .env
# add OPENAI_API_KEY when you want labeling (CLI or POST /sessions/label)
```

`npm start` and `npm run label` load `.env` from the repo root via `dotenv`. `npm run ingest` uses the default paths below unless you pass a JSONL path or set `DB_PATH` in the shell environment.


| Variable         | Purpose                                                 |
| ---------------- | ------------------------------------------------------- |
| `OPENAI_API_KEY` | Required for `npm run label` or `POST /sessions/label`. |
| `OPENAI_MODEL`   | Defaults to `gpt-4o-mini`.                              |
| `DB_PATH`        | SQLite file (default `data/activity.db`).               |
| `PORT` / `HOST`  | HTTP bind (defaults `3000` / `0.0.0.0`).                |
| `LABEL_LIMIT`    | CLI labeler batch cap (default `50`).                   |


## Ingest, serve, smoke-test

Rebuild SQLite from the JSONL (wipes and rebuilds `events`, derived `activity_events`, and `sessions`):

```bash
npm run ingest
# optional: npm run ingest -- /path/to/other.jsonl
```

Start the API:

```bash
npm start
```

**Contract:** see `openapi.yaml`. **Explore:** Swagger UI at `http://localhost:3000/docs` (OpenAPI JSON at `/docs/json`). Host/port follow `HOST` / `PORT`.

### Testing with curl

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/sessions | jq '.sessions | length'
curl -s http://localhost:3000/sessions | jq '.sessions[] | {
  id,
  start: .start_ts_utc,
  end: .end_ts_utc,
  active_observations: .event_count,
  summary: (.summary_json | fromjson | {
    topActivityCategories,
    topActivityHints,
    background: .background.topHosts[0:3]
  })
}'
curl -sG 'http://localhost:3000/sessions' \
  --data-urlencode 'from=2025-10-14T12:00:00-07:00' \
  --data-urlencode 'to=2025-10-14T18:00:00-07:00' | jq '.sessions | length'
curl -s http://localhost:3000/sessions/extremes | jq .
curl -sG 'http://localhost:3000/sessions/extremes' \
  --data-urlencode 'from=2025-10-14T17:00:00Z' \
  --data-urlencode 'to=2025-10-14T19:00:00Z' | jq .
curl -s http://localhost:3000/insights/time | jq '.ranking[:5]'
curl -sG 'http://localhost:3000/insights/time' \
  --data-urlencode 'from=2025-10-15T05:00:00Z' \
  --data-urlencode 'to=2025-10-15T07:00:00Z' | jq '.ranking[:5]'
FIRST_SESSION_ID=$(curl -s http://localhost:3000/sessions | jq -r '.sessions[0].id')
curl -s "http://localhost:3000/sessions/${FIRST_SESSION_ID}/summary" | jq .
curl -s -X POST http://localhost:3000/sessions/label \
  -H 'content-type: application/json' -d '{"limit":10}'
```

### testing with Postman/browser

```bash
GET http://localhost:3000/health
GET http://localhost:3000/sessions
GET http://localhost:3000/sessions?from=2025-10-14T18:00:00.000Z&to=2025-10-14T19:00:00.000Z
GET http://localhost:3000/sessions/extremes
GET http://localhost:3000/sessions/extremes?from=2025-10-14T18:00:00.000Z&to=2025-10-14T19:00:00.000Z
GET http://localhost:3000/insights/time
GET http://localhost:3000/insights/time?from=2025-10-15T05:00:00.000Z&to=2025-10-15T07:00:00.000Z
GET http://localhost:3000/sessions/{id}/summary
POST http://localhost:3000/sessions/label
body{"limit":10}
```

For endpoints with `from` / `to`, Postman **Query Params** rows must be **checked** or they are omitted from the request and the handler returns the unfiltered result.

## Label sessions (LLM)

```bash
npm run label
```

## Activity modeling note

Raw HTTP volume is not treated as attention. Ingest builds a derived `activity_events` table that classifies each request as foreground, background, asset, or unknown. Session boundaries, focus/fragmentation scores, time-spent rankings, and LLM prompts use foreground-weighted observations; Dropbox/Slack polling, telemetry, and static assets are retained as background context but do not dominate the primary outputs.

## Other commands

```bash
npm run typecheck
npm run starter    # minimal JSONL smoke load
```

## Troubleshooting

If `tsx` is not found when invoked directly, use **`npm start`**, **`npm run ingest`**, or **`npm run label`** (they use `node_modules/.bin`), or **`npx tsx src/server.ts`**.