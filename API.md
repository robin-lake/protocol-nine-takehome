# HTTP Activity API

The HTTP contract is defined in **[OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0)** as [`openapi.yaml`](./openapi.yaml) at the repository root.

- **Swagger UI (browser):** `http://localhost:3000/docs` (override host/port with `HOST` / `PORT`)
- **OpenAPI JSON (machine-readable):** `http://localhost:3000/docs/json` — generated from the same spec the UI uses
- **Source YAML:** `openapi.yaml` in the repo (edit this file to change the documented contract)

## Prerequisites

Run ingestion first so SQLite is populated:

```bash
npm run ingest
```

## Example `curl` commands

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/sessions | jq '.sessions | length'
curl -sG 'http://localhost:3000/sessions' --data-urlencode 'from=2025-10-14T12:00:00-07:00' --data-urlencode 'to=2025-10-14T18:00:00-07:00' | jq '.sessions | length'
curl -s http://localhost:3000/sessions/extremes | jq .
curl -s http://localhost:3000/insights/time | jq '.ranking[:10]'
curl -s http://localhost:3000/sessions/1/summary | jq .
curl -s -X POST http://localhost:3000/sessions/label -H 'content-type: application/json' -d '{"limit":10}'
```
