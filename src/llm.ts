import OpenAI from "openai";
import type { SqliteDatabase } from "./db.js";
import type { SessionSummary } from "./types.js";

const MAX_TOP_HOSTS_IN_PROMPT = 12;
const MAX_TOP_PATHS_IN_PROMPT = 8;

export interface SessionLabelRow {
  id: number;
  start_ts_utc: string;
  end_ts_utc: string;
  duration_sec: number;
  event_count: number;
  summary_json: string;
}

function formatSummaryForPrompt(summary: SessionSummary): string {
  const categories = summary.topActivityCategories.slice(0, 8);
  const hints = summary.topActivityHints.slice(0, 10);
  const hosts = summary.topHosts.slice(0, MAX_TOP_HOSTS_IN_PROMPT);
  const paths = summary.topPaths.slice(0, MAX_TOP_PATHS_IN_PROMPT);
  const apps = summary.apps;
  return [
    `Foreground observations: ${summary.foregroundEventCount}`,
    `Background/asset requests in same window: ${summary.backgroundEventCount}`,
    "Primary activity categories (category: foreground weight):",
    ...categories.map(([h, n]) => `  - ${h}: ${n}`),
    "Primary label hints (hint: foreground weight):",
    ...hints.map(([h, n]) => `  - ${h}: ${n}`),
    "Foreground hosts (hostname: foreground weight):",
    ...hosts.map(([h, n]) => `  - ${h}: ${n}`),
    "Foreground paths (path: foreground weight):",
    ...paths.map(([p, n]) => `  - ${p || "(empty)"}: ${n}`),
    "Foreground apps (app: foreground weight):",
    ...apps.map(([a, n]) => `  - ${a}: ${n}`),
    "Background noise (do NOT use as the primary label):",
    ...summary.background.topHosts.slice(0, 8).map(([h, n]) => `  - ${h}: ${n}`),
    "Background reasons:",
    ...summary.background.topReasons.slice(0, 8).map(([h, n]) => `  - ${h}: ${n}`),
  ].join("\n");
}

const SYSTEM_PROMPT = `You label a single user's HTTP activity session for an internal analytics prototype.
Rules:
- Output MUST be a single JSON object with keys: label (string, max 120 chars), rationale (string, max 240 chars), confidence ("high"|"medium"|"low").
- The label MUST only describe patterns visible in the provided foreground activity lists. Do not invent sites or activities not supported by the lists.
- Background noise is supplied only as cautionary context. Do not label a session as Dropbox/Slack/Gmail sync unless there is little or no foreground evidence.
- If foreground evidence is sparse or ambiguous, use a conservative label and set confidence to "low".
- If ambiguous, use a conservative label and set confidence to "low".`;

export async function labelSession(
  client: OpenAI,
  model: string,
  row: SessionLabelRow,
): Promise<{ label: string; rationale: string; confidence: string }> {
  const summary = JSON.parse(row.summary_json) as SessionSummary;
  const userContent = [
    `Session window (UTC): ${row.start_ts_utc} → ${row.end_ts_utc}`,
    `Duration (wall clock, seconds): ${row.duration_sec}`,
    `Event count: ${row.event_count}`,
    "",
    "Grounding material (only use these):",
    formatSummaryForPrompt(summary),
    "",
    'Return JSON only: {"label":"...","rationale":"...","confidence":"high|medium|low"}',
  ].join("\n");

  const resp = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });

  const text = resp.choices[0]?.message?.content;
  if (!text) throw new Error("Empty completion");
  const parsed = JSON.parse(text) as { label?: string; rationale?: string; confidence?: string };
  const label = (parsed.label ?? "Unknown activity").slice(0, 120);
  const rationale = (parsed.rationale ?? "").slice(0, 240);
  const confidence = parsed.confidence === "high" || parsed.confidence === "low" ? parsed.confidence : "medium";
  return { label, rationale, confidence };
}

export async function labelAllPendingSessions(
  db: SqliteDatabase,
  options: { model?: string; limit?: number; delayMs?: number } = {},
): Promise<{ labeled: number; errors: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const limit = options.limit ?? 50;
  const delayMs = options.delayMs ?? 150;

  const client = new OpenAI({ apiKey });
  const rows = db
    .prepare(
      `SELECT id, start_ts_utc, end_ts_utc, duration_sec, event_count, summary_json
       FROM sessions
       WHERE label IS NULL
       ORDER BY start_ms ASC
       LIMIT ?`,
    )
    .all(limit) as SessionLabelRow[];

  const update = db.prepare(
    `UPDATE sessions
     SET label = @label, label_model = @label_model, label_error = NULL, labeled_at = @labeled_at
     WHERE id = @id`,
  );
  const updateErr = db.prepare(
    `UPDATE sessions SET label_error = @label_error, label_model = @label_model WHERE id = @id`,
  );

  let labeled = 0;
  let errors = 0;
  const labeledAt = new Date().toISOString();

  for (const row of rows) {
    try {
      const { label, rationale, confidence } = await labelSession(client, model, row);
      const combined = confidence === "high" ? label : `${label} (${confidence})`;
      const withNote = rationale ? `${combined} — ${rationale}` : combined;
      update.run({
        id: row.id,
        label: withNote.slice(0, 500),
        label_model: model,
        labeled_at: labeledAt,
      });
      labeled += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateErr.run({ id: row.id, label_error: msg.slice(0, 2000), label_model: model });
      errors += 1;
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return { labeled, errors };
}
