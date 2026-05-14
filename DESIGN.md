# Design: HTTP Activity Intelligence (take-home)

## Requirements and assumptions

The brief asks for ingestion + a persisted model, an API that answers three session-centric questions, an LLM that labels each session with **grounded** short text, and honest scoping for a **2–3 hour** build.

**Assumptions:** single user, single JSONL day, trusted local data, Node 20 runtime, OpenAI-compatible key available for labeling only. **Quirks noticed:** mixed timestamp offsets vs `Z`, heavy Slack/Dropbox background volume, CDN/analytics fan-out on real page loads, duplicate proxy retries, `client_ip` changes, and long stretches where HTTP never fully goes quiet because sync apps keep polling.

## Data model (chosen)

**SQLite** with two core entities:

1. `**events`** — one row per ingested HTTP row with `ts_ms` / `ts_utc` normalized from ISO strings via `Date.parse` (UTC storage), original payload fields, and a `dedupe_key` (`ts_ms|method|host|path`) with `INSERT OR IGNORE` to drop obvious duplicates.
2. `sessions` — materialized segments with metrics (`duration_sec`, `event_count`, `unique_hosts`), derived scores (`focus_score`, `fragmentation_score`), `summary_json` (top hosts/paths/apps for API + LLM), and optional `label` / `label_error` / `label_model` / `labeled_at`.

This shape maps directly to the three API questions and keeps the LLM context **bounded** without shipping the entire event stream per request.

## Alternatives considered (and rejected)

- **Graph of host↔host transitions per request** — expressive for navigation hypotheses, but overkill for the required queries within the time budget; would push complexity into graph analytics without delivering session answers faster than a simple session table + aggregates.
- **Events-only storage (compute sessions on the fly)** — avoids migrations but forces repeated full scans and makes LLM input assembly easy to get wrong (accidentally prompt with huge payloads); materialized `sessions` + `summary_json` is cheaper and clearer for reviewers.
- **Single aggregated JSON blob on disk** — quickest to sketch, but awkward for SQL-style insights, harder to incrementally label, and weaker story for “persist a representation” in a conventional sense.

## Sessionization

**Primary rule:** sort events by `ts_ms` and break a session when the gap to the previous event exceeds **12 minutes** (`IDLE_GAP_MS`).

**Pragmatic addition:** cap wall-clock span at **3 hours** (`MAX_SESSION_SPAN_MS`). The sample dataset has **no** 12+ minute inter-event gap (continuous Dropbox/Slack traffic keeps gaps sub-minute), so gap-only segmentation collapses to one giant session. The span cap is an explicit compromise: it manufactures boundaries where the transport log never goes quiet, and it is called out here rather than pretending idle detection worked on raw traffic.

**Summaries inside a session:** top hosts/paths/apps by raw event counts (not bytes-weighted) to keep computation simple and aligned with “what the network saw.”

## Metrics for the API questions

- **Focus score (0–1):** longest run of consecutive events sharing the same `(source_app, tab_id)` where each step gap ≤ **2 minutes**, divided by the session wall span. Rewards sustained single-tab / single-app stretches.
- **Fragmentation score (0–1):** `0.55 * (app switches between consecutive events) + 0.45 * min(1, unique_hosts / sqrt(n))`, capped at 1. Rewards rapid app churn and host diversity.
- **“Time spent on” (ranking):** for each session, allocate its `duration_sec` across hosts **in proportion to event counts** inside that session, then sum globally by host. This is a deliberate proxy: HTTP events are not dwell time, but this definition is stable, explainable, and cheap.
- **Sessions in a time window:** `GET /sessions?from=…&to=…` accepts optional ISO 8601 bounds (same parse rules as ingest). With both bounds, rows are those whose `[start_ms, end_ms]` **overlaps** the interval; one bound alone gives an open-ended filter. Invalid strings or `from` > `to` return **400**.

## LLM labeling design

- **Provider:** OpenAI Chat Completions (`gpt-4o-mini` default), `OPENAI_API_KEY` + optional `OPENAI_MODEL`.
- **Grounding:** system prompt requires JSON output (`label`, `rationale`, `confidence`) and forbids inventing destinations not present in the provided top-host/path/app lists; conservative copy for ambiguous/pollution-heavy sessions.
- **Context caps:** only session bounds, counts, and truncated top-N lists go into the prompt — never the full event list.
- **Persistence & cost:** labels stored on `sessions`; `POST /sessions/label` and `npm run label` skip rows that already have `label`. Sequential calls with a small delay reduce burst rate limits. Failures write `label_error` and leave the API usable without labels.
- **Failure modes:** missing key, timeouts/model errors, malformed JSON — caught per session so one bad row does not abort the batch.

## Scaling beyond one user / one day

Shard by `user_id` + day, append-only event ingest with idempotent natural keys, move SQLite to managed Postgres, precompute sessions in a worker with back-pressure, store summaries suitable for RAG, batch LLM calls with caching keyed by `(session_hash, model_version)`, and add privacy controls (redact paths, PII-safe summarization before any cloud call).

## What was cut (on purpose)

Auth/multi-tenant isolation, streaming ingest, richer CDN collapsing / registrable-domain rollup, browser-only foreground detection, alternative LLM providers in-code, automated tests, OpenAPI generator UI, and perfect alignment between “HTTP intensity” and human “attention minutes.” Those are all reasonable next steps once the core narrative (sessions → questions → grounded labels) is credible.