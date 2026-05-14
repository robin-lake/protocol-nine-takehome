# Design: HTTP Activity Intelligence (take-home)

## Requirements and assumptions

The brief asks for ingestion + a persisted model, an API that answers three session-centric questions, an LLM that labels each session with **grounded** short text, and honest scoping for a **2–3 hour** build.

**Assumptions:** single user, single JSONL day, trusted local data, Node 20 runtime, OpenAI-compatible key available for labeling only. **Quirks noticed:** mixed timestamp offsets vs `Z`, heavy Slack/Dropbox background volume, CDN/analytics fan-out on real page loads, duplicate proxy retries, `client_ip` changes, and long stretches where HTTP never fully goes quiet because sync apps keep polling.

## Data model (chosen)

**SQLite** with three core entities:

1. `events` — one row per ingested HTTP row with `ts_ms` / `ts_utc` normalized from ISO strings via `Date.parse` (UTC storage), original payload fields, and a `dedupe_key` (`ts_ms|method|host|path`) with `INSERT OR IGNORE` to drop obvious duplicates.
2. `activity_events` — a derived, auditable classification of each request as `foreground`, `background`, `asset`, or `unknown`, plus a canonical host, activity category, label hint, weight, and reason. Slack/Dropbox polling, analytics, and CDN/static requests are retained but downweighted or excluded from attention metrics.
3. `sessions` — materialized segments built from foreground/unknown observations with metrics (`duration_sec`, `event_count`, `unique_hosts`), derived scores (`focus_score`, `fragmentation_score`), `summary_json` (foreground activity + background rollups for API + LLM), and optional `label` / `label_error` / `label_model` / `labeled_at`.

This shape maps directly to the three API questions, keeps the LLM context **bounded**, and prevents background HTTP volume from being mistaken for human attention.

## Alternatives considered (and rejected)

- **Graph of host↔host transitions per request** — expressive for navigation hypotheses, but overkill for the required queries within the time budget; would push complexity into graph analytics without delivering session answers faster than a simple session table + aggregates.
- **Events-only storage (compute sessions on the fly)** — avoids migrations but forces repeated full scans and makes LLM input assembly easy to get wrong (accidentally prompt with huge payloads); materialized `sessions` + `summary_json` is cheaper and clearer for reviewers.
- **Single aggregated JSON blob on disk** — quickest to sketch, but awkward for SQL-style insights, harder to incrementally label, and weaker story for “persist a representation” in a conventional sense.

## Sessionization

**Primary rule:** classify events first, then sort foreground/unknown observations by `ts_ms` and break a session when the gap to the previous active observation exceeds **20 minutes** (`IDLE_GAP_MS`), when the activity category changes after an **8 minute** gap, or when an active span exceeds **2 hours**. The span cap is a guardrail for dense foreground streams, not a claim that two hours is a universal human session length.

The earlier raw-gap approach collapsed because continuous Dropbox/Slack traffic keeps inter-request gaps sub-minute. The derived `activity_events` layer lets those requests remain visible as background context while excluding them from boundary detection.

**Estimated duration:** each foreground observation receives bounded dwell time until the next active observation in the same session, capped at **10 minutes**. This is still a proxy, but it is closer to attention than raw request counts or raw wall-clock span.

**Summaries inside a session:** top activity categories/hints/hosts/paths/apps are foreground-weighted. Background hosts and classifier reasons are attached separately so the labeler can see noise without using it as the primary label.

## Metrics for the API questions

- **Focus score (0–1):** longest run over the same tab/app/category context, using foreground observations with gaps ≤ **10 minutes**, divided by estimated active time. Rewards sustained active contexts rather than Dropbox long-poll streams.
- **Fragmentation score (0–1):** `0.55 * (activity-category switches between consecutive observations) + 0.45 * min(1, unique foreground hosts / sqrt(n))`, capped at 1. Rewards actual context churn and foreground host diversity.
- **“Time spent on” (ranking):** foreground/unknown observations receive bounded dwell time until the next observation, multiplied by classifier weight, then grouped by activity category. Background sync, telemetry, and static assets are excluded from the ranking.
- **Time windows:** `GET /sessions?from=…&to=…`, `GET /sessions/extremes?from=…&to=…`, and `GET /insights/time?from=…&to=…` accept optional ISO 8601 bounds (same parse rules as ingest). Session endpoints use `[start_ms, end_ms]` **overlap** semantics; `/insights/time` filters foreground observations inside the bounds. One bound alone gives an open-ended filter. Invalid strings or `from` > `to` return **400**.

## LLM labeling design

- **Provider:** OpenAI Chat Completions (`gpt-4o-mini` default), `OPENAI_API_KEY` + optional `OPENAI_MODEL`.
- **Grounding:** system prompt requires JSON output (`label`, `rationale`, `confidence`) and forbids inventing destinations not present in the foreground activity lists. Background rollups are shown only as “do not use as primary label” context.
- **Context caps:** only session bounds, foreground category/hint/host/path/app rollups, and truncated background rollups go into the prompt — never the full event list.
- **Persistence & cost:** labels stored on `sessions`; `POST /sessions/label` and `npm run label` skip rows that already have `label`. Sequential calls with a small delay reduce burst rate limits. Failures write `label_error` and leave the API usable without labels.
- **Failure modes:** missing key, timeouts/model errors, malformed JSON — caught per session so one bad row does not abort the batch.

## Scaling beyond one user / one day

Shard by `user_id` + day, append-only event ingest with idempotent natural keys, move SQLite to managed Postgres, precompute sessions in a worker with back-pressure, store summaries suitable for RAG, batch LLM calls with caching keyed by `(session_hash, model_version)`, and add privacy controls (redact paths, PII-safe summarization before any cloud call).

## What was cut (on purpose)

Auth/multi-tenant isolation, streaming ingest, robust registrable-domain parsing, learned foreground detection, browser focus telemetry, alternative LLM providers in-code, automated tests, OpenAPI generator UI, and perfect alignment between “HTTP intensity” and human “attention minutes.” Those are all reasonable next steps once the core narrative (sessions → questions → grounded labels) is credible.