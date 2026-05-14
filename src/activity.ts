import type { SqliteDatabase } from "./db.js";
import type { ActivityClassification, EventRow } from "./types.js";

interface ClassifiedActivity {
  canonicalHost: string;
  activityCategory: string;
  labelHint: string;
  classification: ActivityClassification;
  weight: number;
  reason: string;
}

const STATIC_EXTENSIONS = /\.(?:avif|css|gif|ico|jpe?g|js|json|map|png|svg|webp|woff2?|ttf)(?:$|[?#])/i;
const CDN_HOSTS = new Set([
  "ajax.googleapis.com",
  "cdn.cloudflare.com",
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "static.google.com",
  "unpkg.com",
  "use.typekit.net",
]);
const ANALYTICS_HOST_FRAGMENTS = [
  "doubleclick.net",
  "google-analytics.com",
  "mixpanel.com",
  "segment.io",
  "sentry.io",
];

function canonicalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function searchQuery(path: string | null): string | null {
  if (!path) return null;
  const marker = path.match(/[?&]q=([^&]+)/);
  if (!marker) return null;
  return decodeURIComponent(marker[1]!.replace(/\+/g, " ")).slice(0, 80);
}

function isAnalytics(host: string, path: string | null): boolean {
  return (
    ANALYTICS_HOST_FRAGMENTS.some((fragment) => host.includes(fragment)) ||
    path === "/track" ||
    path === "/r/collect" ||
    path === "/g/collect" ||
    path?.includes("/envelope/") === true ||
    path?.includes("/collect") === true
  );
}

function isStaticAsset(host: string, path: string | null): boolean {
  return CDN_HOSTS.has(host) || (path !== null && STATIC_EXTENSIONS.test(path));
}

export function classifyEvent(event: EventRow): ClassifiedActivity {
  const host = canonicalizeHost(event.host);
  const path = event.path ?? "";

  if (host === "client.dropbox.com" && path.includes("/list_folder/longpoll")) {
    return {
      canonicalHost: host,
      activityCategory: "background sync",
      labelHint: "Dropbox background sync",
      classification: "background",
      weight: 0,
      reason: "dropbox_longpoll",
    };
  }

  if (
    host === "wss-primary.slack.com" ||
    (host === "slack.com" && (path.includes("users.setPresence") || path.includes("token=xoxb-")))
  ) {
    return {
      canonicalHost: host,
      activityCategory: "background messaging",
      labelHint: "Slack presence/websocket polling",
      classification: "background",
      weight: 0,
      reason: "slack_presence_or_websocket",
    };
  }

  if (host === "mail.google.com" && path.startsWith("/sync/")) {
    return {
      canonicalHost: host,
      activityCategory: "background email sync",
      labelHint: "Gmail background sync",
      classification: "background",
      weight: 0,
      reason: "gmail_sync",
    };
  }

  if (isAnalytics(host, event.path)) {
    return {
      canonicalHost: host,
      activityCategory: "analytics/telemetry",
      labelHint: `${host} telemetry`,
      classification: "background",
      weight: 0,
      reason: "analytics_or_telemetry",
    };
  }

  if (isStaticAsset(host, event.path)) {
    return {
      canonicalHost: host,
      activityCategory: "page asset loading",
      labelHint: `${host} static asset`,
      classification: "asset",
      weight: 0.05,
      reason: "static_asset_or_cdn",
    };
  }

  if (host === "localhost" || event.source_app === "terminal") {
    return {
      canonicalHost: host,
      activityCategory: "local development",
      labelHint: "local API/development work",
      classification: "foreground",
      weight: 1,
      reason: "terminal_or_localhost",
    };
  }

  if (host === "google.com" && path.startsWith("/search")) {
    const query = searchQuery(event.path);
    return {
      canonicalHost: host,
      activityCategory: "web search",
      labelHint: query ? `Google search: ${query}` : "Google search",
      classification: "foreground",
      weight: 1,
      reason: "search_result_page",
    };
  }

  if (host === "github.com") {
    return {
      canonicalHost: host,
      activityCategory: "software development",
      labelHint: "GitHub development work",
      classification: "foreground",
      weight: 1,
      reason: "developer_site",
    };
  }

  if (host === "stackoverflow.com") {
    return {
      canonicalHost: host,
      activityCategory: "developer research",
      labelHint: "Stack Overflow research",
      classification: "foreground",
      weight: 1,
      reason: "developer_site",
    };
  }

  if (host === "neo4j.com") {
    return {
      canonicalHost: host,
      activityCategory: "technical research",
      labelHint: "Neo4j documentation/research",
      classification: "foreground",
      weight: 1,
      reason: "technical_docs",
    };
  }

  if (host === "notion.so") {
    return {
      canonicalHost: host,
      activityCategory: "writing/planning",
      labelHint: "Notion document work",
      classification: "foreground",
      weight: 1,
      reason: "document_app",
    };
  }

  if (host === "calendar.google.com") {
    return {
      canonicalHost: host,
      activityCategory: "calendar",
      labelHint: "Google Calendar",
      classification: "foreground",
      weight: 0.8,
      reason: "productivity_app",
    };
  }

  if (host === "mail.google.com") {
    return {
      canonicalHost: host,
      activityCategory: "email",
      labelHint: "Gmail",
      classification: "foreground",
      weight: 0.8,
      reason: "productivity_app",
    };
  }

  if (host === "app.slack.com" || host === "slack.com") {
    return {
      canonicalHost: host,
      activityCategory: "communication",
      labelHint: "Slack",
      classification: "foreground",
      weight: 0.6,
      reason: "communication_app",
    };
  }

  if (event.source_app === "chrome") {
    return {
      canonicalHost: host,
      activityCategory: "web browsing",
      labelHint: host,
      classification: "unknown",
      weight: 0.4,
      reason: "unclassified_browser_request",
    };
  }

  return {
    canonicalHost: host,
    activityCategory: "other app activity",
    labelHint: `${event.source_app}: ${host}`,
    classification: "unknown",
    weight: 0.2,
    reason: "unclassified_app_request",
  };
}

export function rebuildActivityEvents(db: SqliteDatabase): number {
  db.exec("DELETE FROM activity_events");
  const rows = db
    .prepare(
      `SELECT id, ts_ms, ts_utc, timestamp_raw, method, host, path, status_code,
              bytes_out, bytes_in, source_app, tab_id, referrer, client_ip
       FROM events ORDER BY ts_ms ASC, id ASC`,
    )
    .all() as EventRow[];

  const insert = db.prepare(`
    INSERT INTO activity_events (
      event_id, ts_ms, ts_utc, source_app, tab_id, host, path, canonical_host,
      activity_category, label_hint, classification, weight, reason
    ) VALUES (
      @event_id, @ts_ms, @ts_utc, @source_app, @tab_id, @host, @path, @canonical_host,
      @activity_category, @label_hint, @classification, @weight, @reason
    )
  `);

  const insertAll = db.transaction((events: EventRow[]) => {
    for (const event of events) {
      const classified = classifyEvent(event);
      insert.run({
        event_id: event.id,
        ts_ms: event.ts_ms,
        ts_utc: event.ts_utc,
        source_app: event.source_app,
        tab_id: event.tab_id,
        host: event.host,
        path: event.path,
        canonical_host: classified.canonicalHost,
        activity_category: classified.activityCategory,
        label_hint: classified.labelHint,
        classification: classified.classification,
        weight: classified.weight,
        reason: classified.reason,
      });
    }
  });

  insertAll(rows);
  return rows.length;
}
