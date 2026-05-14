import "dotenv/config";
import { openDatabase } from "../db.js";
import { labelAllPendingSessions } from "../llm.js";
import { DEFAULT_DB_PATH } from "../paths.js";

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  const limit = Number(process.env.LABEL_LIMIT ?? 50);
  const db = openDatabase(dbPath);
  try {
    const { labeled, errors } = await labelAllPendingSessions(db, { limit });
    console.log(`Labeled: ${labeled}, errors: ${errors}`);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
