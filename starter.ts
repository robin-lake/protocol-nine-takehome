/**
 * Minimal starter. Run this to confirm you can load the dataset.
 * It does the absolute minimum: opens the file, parses each line as JSON,
 * prints a few stats. Replace it with whatever you want — it has no opinions
 * about your data model, your storage, or your sessionization.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_FILE = join(__dirname, "http_events.jsonl");

interface HttpEvent {
  timestamp: string;
  host: string;
  source_app: string;
}

function* loadEvents(): Generator<HttpEvent> {
  const text = readFileSync(DATA_FILE, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed) as HttpEvent;
  }
}

function counter(values: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

function mostCommon(counts: Map<string, number>, limit?: number): [string, number][] {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

function main(): void {
  const events = [...loadEvents()];
  console.log(`Loaded ${events.length.toLocaleString("en-US")} events`);
  console.log(`First timestamp: ${events[0]!.timestamp}`);
  console.log(`Last timestamp:  ${events.at(-1)!.timestamp}`);

  console.log("\nTop 5 hosts by raw count:");
  for (const [host, n] of mostCommon(counter(events.map((e) => e.host)), 5)) {
    console.log(`  ${String(n).padStart(5, " ")}  ${host}`);
  }

  console.log("\nSource apps:");
  for (const [app, n] of mostCommon(counter(events.map((e) => e.source_app)))) {
    console.log(`  ${String(n).padStart(5, " ")}  ${app}`);
  }
}

main();
