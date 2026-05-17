/**
 * Session Analyzer ExtensionProvider
 *
 * Parses JSONL session files on turn end, reconstructs context blocks
 * and caching metrics, and caches results to SQLite. Exposes
 * getAnalysis() for the daemon's get_session_analysis runner command.
 */
import { readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionProvider,
  ProviderInitContext,
  ProviderContext,
  BeforeAgentStartEvent,
  ContextContribution,
  SessionStartEvent,
} from "../../providers/types.js";
import { parseJsonlEntries } from "./parser.js";
import { reconstructContext } from "./analyzer.js";
import {
  openDb,
  loadAnalysis,
  saveAnalysis,
  getProcessingState,
  saveProcessingState,
} from "./db.js";
import type { SessionAnalysis } from "./types.js";

const PROVIDER_ID = "session-analyzer";
const DEFAULT_DB_DIR = join(homedir(), ".pizzapi", "provider-data", PROVIDER_ID);

class SessionAnalyzerProvider implements ExtensionProvider {
  readonly id = PROVIDER_ID;
  readonly label = "Context & Cache Analyzer";
  readonly capabilities = ["lifecycle", "context"] as const;

  #db: ReturnType<typeof openDb> | null = null;
  #dbDir: string = DEFAULT_DB_DIR;
  #contextWindows: Map<string, number> = new Map();

  init(ctx: ProviderInitContext): void {
    this.#dbDir =
      typeof ctx.config.dbPath === "string"
        ? ctx.config.dbPath
        : DEFAULT_DB_DIR;
    this.#db = openDb(this.#dbDir);
  }

  dispose(): void {
    this.#db?.close();
    this.#db = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async onSessionStart(event: SessionStartEvent, _ctx: ProviderContext): Promise<void> {
    // Cache model context window if available
    if (event.model?.provider && event.model?.id) {
      // Store context window for this model if we know it
      // The contextWindow comes from model metadata
    }
  }

  async onTurnEnd(
    _event: { turnIndex: number; message: unknown },
    ctx: ProviderContext,
  ): Promise<void> {
    await this.#reanalyze(ctx.sessionFile, ctx.sessionId, ctx);
  }

  async onSessionClose(
    _event: { reason: string; sessionFile: string },
    ctx: ProviderContext,
  ): Promise<{ label: string; jobRef: Record<string, unknown> } | null> {
    if (_event.sessionFile) {
      await this.#reanalyze(_event.sessionFile, ctx.sessionId, ctx);
    }
    return { label: "Finalizing session analysis…", jobRef: {} };
  }

  // ── Context Injection ──────────────────────────────────────────

  async onBeforeAgentStart(
    _event: BeforeAgentStartEvent,
    ctx: ProviderContext,
  ): Promise<ContextContribution[]> {
    const analysis = await this.#getOrRevalidate(ctx.sessionId, ctx.sessionFile);
    if (!analysis) return [];

    const { summary } = analysis;
    if (
      summary.cacheHitRate < 0.1 ||
      !summary.estimatedCacheSavings ||
      summary.estimatedCacheSavings <= 0
    ) {
      return [];
    }

    return [
      {
        text: `Cache efficiency: ${(summary.cacheHitRate * 100).toFixed(0)}% hit rate (est. savings: $${summary.estimatedCacheSavings.toFixed(2)} this session)`,
        placement: "append",
        order: 999,
        dedupeKey: "session-analyzer-cache",
        summary: "Cache efficiency hint",
      },
    ];
  }

  // ── Public API (called by daemon's get_session_analysis handler) ──

  getAnalysis(sessionId: string): SessionAnalysis | null {
    if (!this.#db) return null;
    return loadAnalysis(this.#db, sessionId);
  }

  // ── Private helpers ────────────────────────────────────────────

  async #reanalyze(
    sessionFile: string | undefined,
    sessionId: string,
    _ctx: ProviderContext,
  ): Promise<SessionAnalysis | null> {
    const db = this.#db;
    if (!db || !sessionFile || !existsSync(sessionFile)) return null;

    try {
      const content = readFileSync(sessionFile, "utf-8");
      const mtimeMs = statSync(sessionFile).mtimeMs;

      // Skip if file hasn't changed
      const state = getProcessingState(db, sessionId);
      if (state && state.lastMtimeMs === mtimeMs) {
        return loadAnalysis(db, sessionId);
      }

      const { entries } = parseJsonlEntries(content);
      const leafId = findLeafId(entries);
      const contextWindows = this.#contextWindows.size > 0
        ? this.#contextWindows
        : undefined;

      const analysis = reconstructContext(entries, leafId, contextWindows);
      saveAnalysis(db, analysis);
      saveProcessingState(db, sessionId, mtimeMs);

      return analysis;
    } catch {
      return null;
    }
  }

  async #getOrRevalidate(
    sessionId: string,
    sessionFile?: string,
  ): Promise<SessionAnalysis | null> {
    // Try to revalidate from file first
    const fresh = await this.#reanalyze(sessionFile, sessionId, {} as ProviderContext);
    if (fresh) return fresh;

    // Fall back to cached
    if (this.#db) return loadAnalysis(this.#db, sessionId);
    return null;
  }
}

function findLeafId(entries: { id?: string }[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.id) return entries[i]!.id!;
  }
  return "root";
}

export default new SessionAnalyzerProvider();
