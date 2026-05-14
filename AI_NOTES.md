# AI tooling notes (HTTP Activity take-home)

## Prompts / workflow (representative)

- Asked Cursor to generate a plan and then implemented the generated plan: SQLite ingest, sessionization with explicit metrics, Fastify routes, OpenAI labeling, and submission docs without editing the plan file.
- Iterated once after noticing **gap-only sessionization produced a single session** because Dropbox/Slack traffic keeps inter-event gaps under twelve minutes for the entire sample day. Added a **maximum session span** cap and documented the tradeoff in `DESIGN.md` rather than silently shipping one session.
- Asked Cursor to formalize the HTTP contract as **OpenAPI 3.1** in repo-root `openapi.yaml`, document usage in **`README.md`**, then add **Swagger UI** via `@fastify/swagger` (static spec loaded from that file) and `@fastify/swagger-ui` at `/docs` with JSON at `/docs/json`. Dropped a redundant `GET /openapi.yaml` route once Swagger served the same spec.
- After review, identified that raw event counts still let Slack/Dropbox/background sync dominate. Reworked the model to add a derived `activity_events` classification layer and rebuild sessions, insights, and LLM prompts from foreground-weighted observations instead.

## Where AI output was accepted vs overridden

### Accepted ###
- Overall file layout (`src/db.ts`, `src/sessionize.ts`, CLI + server split), using `better-sqlite3` + `tsx` worked well with initial prompting, general API shape looked good
- After updating, OpenAPI + Fastify Swagger integration worked as expected.
- replaced initial request count weighting with foreground-observation weighting.
### Overridden ###

- LLM did not provide a way to query by time ranges, needed to update
- LLM tried to make an API markdown file outlining the entire spec. Updated to use OpenAPI and Swagger
- Initial LLM design based sessions on arbitrary gaps, ended up getting overwhelmed by background tasks like dropbox
## Places to watch for model mistakes
- LLM labels can still over-interpret generic hosts; prompts require conservative JSON and list-only grounding, but reviewers should treat labels as **assistive**, not ground truth.
- “Time on host” uses event-count-weighted session duration — **not** true dwell time.
- “Time on activity” now uses bounded dwell time over heuristic foreground classifications. It is more realistic than raw event counts, but still not true app/browser focus telemetry.
- **`openapi.yaml` vs code:** the contract is maintained by hand (static Swagger); new or changed routes need matching edits in the YAML or the docs will lie.
