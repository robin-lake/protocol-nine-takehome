# AI tooling notes (HTTP Activity take-home)

## Prompts / workflow (representative)

- Asked Cursor to implement the attached plan: SQLite ingest, sessionization with explicit metrics, Fastify routes, OpenAI labeling, and submission docs without editing the plan file.
- Iterated once after noticing **gap-only sessionization produced a single session** because Dropbox/Slack traffic keeps inter-event gaps under twelve minutes for the entire sample day. Added a **maximum session span** cap and documented the tradeoff in `DESIGN.md` rather than silently shipping one session.
- Asked Cursor to formalize the HTTP contract as **OpenAPI 3.1** in repo-root `openapi.yaml`, point `API.md` at it as canonical, then add **Swagger UI** via `@fastify/swagger` (static spec loaded from that file) and `@fastify/swagger-ui` at `/docs` with JSON at `/docs/json`. Dropped a redundant `GET /openapi.yaml` route once Swagger served the same spec.

## Where AI output was accepted vs overridden

- **Accepted:** overall file layout (`src/db.ts`, `src/sessionize.ts`, CLI + server split), using `better-sqlite3` + `tsx`, and the general API shape from the plan; hand-written `openapi.yaml` + static Fastify swagger integration (no OpenAPI codegen or extra UI beyond Swagger).
- **Overridden:** session boundary logic after empirical check with SQL window `LAG` on `ts_ms` (max gap ~32s). The plan’s idle-gap-only story is correct for “human idle” but not for always-on logs; the span cap is a deliberate product decision for this dataset.

## Places to watch for model mistakes

- LLM labels can still over-interpret generic hosts; prompts require conservative JSON and list-only grounding, but reviewers should treat labels as **assistive**, not ground truth.
- “Time on host” uses event-count-weighted session duration — **not** true dwell time.
- **`openapi.yaml` vs code:** the contract is maintained by hand (static Swagger); new or changed routes need matching edits in the YAML or the docs will lie.
