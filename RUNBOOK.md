# Runbook — HTTP Activity prototype

## Prerequisites

- **Node.js 20.x** (see [`.nvmrc`](.nvmrc) and [`package.json`](package.json) `engines`).
- `http_events.jsonl` at the repository root (already provided for the exercise).

## Install

```bash
nvm use   # if you use nvm
npm install
```

## Configure (labeling only)

```bash
cp .env.example .env
# set OPENAI_API_KEY (optional until you run labeling)
```

`npm start` and `npm run label` read `.env` from the repo root automatically.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Required for `npm run label` or `POST /sessions/label`. |
| `OPENAI_MODEL` | Defaults to `gpt-4o-mini`. |
| `DB_PATH` | Defaults to `data/activity.db` under the repo root. |
| `PORT` | HTTP server port (default `3000`). |
| `HOST` | Bind address (default `0.0.0.0`). |
| `LABEL_LIMIT` | CLI labeler batch size cap (default `50`). |

## Ingest + sessionize

Rebuilds the SQLite file from the JSONL (clears prior `events` / `sessions` rows):

```bash
npm run ingest
# optional: npm run ingest -- /path/to/other.jsonl
```

## HTTP API

```bash
npm start
```

Smoke tests:

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/sessions | head
curl -s http://localhost:3000/sessions/extremes | jq .
curl -s http://localhost:3000/insights/time | jq '.ranking[:5]'
```

Full contract: [`openapi.yaml`](openapi.yaml). With the server running: Swagger UI at `/docs`, OpenAPI JSON at `/docs/json`. Notes and curl examples: [`API.md`](API.md).

## Label sessions (LLM)

```bash
npm run label
# or while the server is running:
curl -s -X POST http://localhost:3000/sessions/label \
  -H 'content-type: application/json' \
  -d '{"limit":10}'
```

## Typecheck

```bash
npm run typecheck
```

## Starter script (dataset smoke test)

```bash
npm run starter
```

## Troubleshooting

- **`tsx: command not found`** when you run `tsx …` by hand — use **`npm start`** / **`npm run ingest`** / **`npm run label`** (they resolve `node_modules/.bin`), or run **`npx tsx src/server.ts`**.
