import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const REPO_ROOT = ROOT;
export const DEFAULT_JSONL_PATH = join(ROOT, "http_events.jsonl");
export const DEFAULT_DB_PATH = join(ROOT, "data", "activity.db");
