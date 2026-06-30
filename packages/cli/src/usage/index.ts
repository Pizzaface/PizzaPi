import { openUsageDb } from "./schema.js";
import { scanSessions } from "./scanner.js";
import { getUsageData } from "./aggregator.js";
import type { UsageData, UsageRange } from "./types.js";
import type { Database } from "bun:sqlite";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("usage");
let db: Database | null = null;
let lastScanAt = 0;
let scanning = false;
let _scanPromise: Promise<void> | null = null;

export function initUsage(): Promise<void> {
  db = openUsageDb();
  // Initial scan in background — returned so callers (e.g. tests) can await it.
  const scan = triggerScan().catch((err) => {
    log.error("initial scan failed:", err);
  });
  return scan;
}

export async function triggerScan(): Promise<void> {
  if (!db || scanning) return;
  scanning = true;
  _scanPromise = (async () => {
    try {
      await scanSessions(db!);
      lastScanAt = Date.now();
    } finally {
      scanning = false;
      _scanPromise = null;
    }
  })();
  return _scanPromise;
}

export function getData(range: UsageRange = "90d"): UsageData | null {
  if (!db) return null;
  // Trigger scan if stale (> 1 min)
  if (Date.now() - lastScanAt > 60_000) {
    triggerScan().catch((err) => {
      log.error("background scan failed:", err);
    }); // fire and forget — return current data
  }
  return getUsageData(db, range);
}

export async function closeUsage(): Promise<void> {
  // Await any in-flight scan before closing the db to prevent it from
  // touching a closed database handle.
  if (_scanPromise) {
    await _scanPromise.catch(() => {});
  }
  db?.close();
  db = null;
  lastScanAt = 0;
  scanning = false;
}
