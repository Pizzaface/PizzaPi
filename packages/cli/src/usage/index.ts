import { openUsageDb } from "./schema.js";
import { scanSessions } from "./scanner.js";
import { getUsageData } from "./aggregator.js";
import type { UsageData, UsageRange } from "./types.js";
import type { Database } from "bun:sqlite";

let db: Database | null = null;
let lastScanAt = 0;
let scanning = false;

export function initUsage(): void {
  db = openUsageDb();
  // Initial scan in background
  triggerScan().catch((err) => {
    console.error("[usage] initial scan failed:", err);
  });
}

export async function triggerScan(): Promise<void> {
  if (!db || scanning) return;
  scanning = true;
  try {
    await scanSessions(db);
    lastScanAt = Date.now();
  } finally {
    scanning = false;
  }
}

export function getData(range: UsageRange = "90d"): UsageData | null {
  if (!db) return null;
  // Trigger scan if stale (> 1 min)
  if (Date.now() - lastScanAt > 60_000) {
    triggerScan().catch((err) => {
      console.error("[usage] background scan failed:", err);
    }); // fire and forget — return current data
  }
  return getUsageData(db, range);
}

export function closeUsage(): void {
  db?.close();
  db = null;
}
