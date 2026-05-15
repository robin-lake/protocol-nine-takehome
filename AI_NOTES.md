# AI Tooling Notes

I used Cursor as a pair-programming assistant for planning, implementation, review, and documentation. I did not treat the first generated design as final; I inspected the outputs, found where the model was misleading, and changed the implementation.

## Prompts / Research Queries Used

Representative prompts:

- "Build a Node 20 take-home solution that ingests `http_events.jsonl`, persists a model, exposes API endpoints for sessions/focus/time-spent, and includes an OpenAI-powered session labeler."
- "Can you look at the code in this project and tell me how well it addresses these requirements? What is lacking and how could it be fixed?" I pasted the take-home API and LLM labeler requirements.
- "Please update this to match OpenAPI spec."
- "Please add Swagger. If the `/openapi.yaml` endpoint is redundant with Swagger, please remove it."
- "Please update the API to include a way to query what sessions occurred within a time range."
- "Please give me a time range that I can use to test this endpoint."
- "When I enter this in Postman... I get all sessions. Can you diagnose this?"
- "My labeled sessions look like they all have the same label. Can you diagnose what is going on?"
- "Please condense the `RUNBOOK.md` and `API.md` files to both be contained within `README.md`; add references to `DESIGN.md` and `AI_NOTES.md`."
- "Look at the assignment description and the code. Where does the implementation fall short of what was asked? Do not write code, summarize gaps."
- "How would you update the code so background noise does not dominate the outputs? How would you get a more realistic sense of what a user spent time on?"
- "Update `/sessions/extremes` and `/insights/time` to accept optional `from` / `to` ranges, matching `/sessions` behavior."
- "Review `DESIGN.md` against the assignment's required design-doc bullets."

## What I Asked AI To Help With

- Initial project structure: SQLite schema, ingest CLI, sessionization module, Fastify server, labeler module, and docs.
- API contract shape, OpenAPI 3.1 spec, and Swagger UI integration at `/docs` with JSON at `/docs/json`.
- Optional time-range query behavior for `/sessions`, then later for `/sessions/extremes` and `/insights/time`.
- Diagnosing why Postman returned all sessions for a filtered URL
- Diagnosing why LLM labels sounded the same; the root cause was similar Slack/Dropbox-heavy summaries plus prompt phrasing, not a per-row copy bug.
- Consolidating temporary docs (`RUNBOOK.md`, `API.md`) into `README.md`.
- Reviewing the implementation against the assignment requirements.
- Iterating on the model after discovering that raw HTTP request counts were dominated by Slack/Dropbox/background polling.
- Keeping README, OpenAPI, and design notes aligned with the code.

## Most Useful Prompts

The most useful prompt was the review prompt asking where the code fell short of the assignment. It exposed that the first implementation technically answered the endpoints but still treated background HTTP volume as user attention.

The second most useful prompt was asking how to prevent background noise from dominating. That led to the `activity_events` layer: classify each request as foreground/background/asset/unknown, build sessions from foreground-weighted observations, and keep background traffic only as context.

The Postman diagnosis prompt was also useful because it forced the API contract to be tested from a real client, not just curl. That led to more careful parsing/validation of `from` / `to`.

## AI Output I Rejected Or Modified

- Rejected a Markdown-only API contract and switched to `openapi.yaml` plus Swagger UI.
- Removed a custom `GET /openapi.yaml` route once Swagger served the static spec and JSON endpoint.
- Merged separate `RUNBOOK.md` / `API.md` style documentation back into one `README.md` to reduce doc drift.
- Reworked the initial gap-only sessionization because Dropbox/Slack polling meant there were almost no meaningful idle gaps.
- Replaced host/event-count-based "time spent" with bounded dwell time over foreground-weighted activity categories.
- Added `from` / `to` filtering beyond the initial `/sessions` endpoint, first documenting `/sessions`, then extending `/sessions/extremes` and `/insights/time`.
- Tightened LLM prompts so background rollups are explicitly "do not use as primary label" context, and softened phrasing that encouraged repetitive labels.

## Design Decisions I Made

- Use SQLite with derived tables rather than compute everything on every request.
- Use OpenAPI/Swagger as the contract instead of maintaining a hand-written API markdown page.
- Preserve raw `events` for auditability and add derived `activity_events` instead of mutating/dropping noisy records.
- Treat Slack/Dropbox/Gmail sync, telemetry, analytics, and static assets as background context rather than attention.
- Estimate time with bounded foreground dwell time, capped at 10 minutes, instead of treating request count or wall-clock span as dwell time.
- Keep labeling as an explicit batch/API step so ingest and core API behavior work without an LLM key.

## Bugs Or Bad Assumptions AI Introduced

- The first model assumed raw inter-request gaps would reveal user sessions. In this dataset, background apps kept the stream alive, so that collapsed activity into misleading large sessions.
- Early "time spent" was based on allocating session duration by raw host request counts, which incorrectly made Dropbox and Slack websocket traffic look like the user's main activity.
- Early API/docs did not include time-range filters everywhere the assignment wording implied "in this period."
- Some generated docs drifted from behavior, especially fixed session IDs in examples, a redundant spec endpoint, and missing time-range support on aggregate endpoints.
- The first LLM prompt accidentally encouraged similar labels because each session summary was dominated by similar background hosts and the prompt contained reusable phrasing.
- The LLM labeler can still over-interpret weak evidence; prompts and summaries reduce this risk, but labels remain assistive rather than ground truth.

## Validation

- Ran `npm run typecheck`.
- Rebuilt the database with `npm run ingest`.
- Smoke-tested `/sessions`, `/sessions/extremes`, `/insights/time`, and filtered `from` / `to` variants with `curl` + `jq`.
- Used Postman/browser behavior to confirm query params need to be sent as checked params or included directly in the URL.
- Checked that `GET /insights/time` now ranks activity categories like calendar, writing/planning, local development, developer research, and software development instead of `client.dropbox.com` or Slack websocket hosts.
- Verified invalid time parameters return `400`.
- Verified Swagger UI loads from the static `openapi.yaml` at `/docs`.
- Checked linter diagnostics on edited files after changes.
