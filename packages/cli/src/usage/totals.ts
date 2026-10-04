import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

type UsageLike = Pick<Partial<Usage>, "input" | "output" | "cacheRead" | "cacheWrite"> & {
  cost?: Partial<Usage["cost"]> | null;
};

export interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }

export function emptyTokenTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsageToTokenTotals(totals: TokenTotals, usage: UsageLike | undefined | null): void {
  if (!usage || typeof usage !== "object") return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += Math.max(0, usage.cost?.total ?? 0);
}

/**
 * Count every usage-bearing session entry. Pi 1.0 adds usage to tool results
 * for nested model work such as codemode `models.*`; old code counted only
 * assistant messages, hiding that spend from PizzaPi UI/accounting.
 */
export function collectSessionTokenUsage(entries: Iterable<SessionEntry>): TokenTotals {
  const totals = emptyTokenTotals();
  for (const entry of entries) {
    switch (entry.type) {
      case "message": {
        const message = entry.message;
        if (message.role === "assistant" || message.role === "toolResult") {
          addUsageToTokenTotals(totals, message.usage);
        }
        break;
      }
      case "usage":
      case "branch_summary":
      case "compaction":
        addUsageToTokenTotals(totals, entry.usage);
        break;
      default:
        break;
    }
  }
  return totals;
}
