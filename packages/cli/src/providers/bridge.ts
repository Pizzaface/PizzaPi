import type {
  ExtensionProvider, ContextProvider, LifecycleHook,
  ContextContribution, ProviderContext, BeforeAgentStartEvent,
  SessionStartEvent, SessionShutdownEvent, TurnEndEvent,
  SessionCloseEvent, SessionCloseResult,
} from "./types";
import { isContextProvider, isLifecycleHook } from "./types";

export interface BeforeAgentStartResult {
  prepend: string[];
  append: string[];
  summaries: string[];
  artifacts: ContextContribution["referencedArtifacts"];
}

interface CollectedContribution {
  providerId: string;
  text: string;
  placement: "prepend" | "append";
  order: number;
  summary: string;
  artifacts?: ContextContribution["referencedArtifacts"];
}

const MAX_CONSECUTIVE_ERRORS = 3;

export class ProviderBridge {
  #providers: ExtensionProvider[];
  #disabled = new Set<string>();
  #errorCounts = new Map<string, number>();
  /** Per-provider dedupe map. Key = dedupeKey, Value = collected contribution. */
  #dedupeState = new Map<string, Map<string, CollectedContribution>>();

  constructor(providers: ExtensionProvider[]) {
    this.#providers = providers;
  }

  isDisabled(providerId: string): boolean {
    return this.#disabled.has(providerId);
  }

  resetDedupeState(): void {
    this.#dedupeState.clear();
  }

  async onBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ProviderContext,
  ): Promise<BeforeAgentStartResult> {
    const collected: CollectedContribution[] = [];

    for (const provider of this.#providers) {
      if (this.#disabled.has(provider.id)) continue;
      if (!isContextProvider(provider)) continue;

      try {
        const contributions = await provider.onBeforeAgentStart(event, ctx);
        if (!contributions || contributions.length === 0) continue;

        let dedupeMap = this.#dedupeState.get(provider.id);
        if (!dedupeMap) {
          dedupeMap = new Map();
          this.#dedupeState.set(provider.id, dedupeMap);
        }

        // Emit all previously stored deduped entries first (stable order)
        for (const [, entry] of dedupeMap) {
          collected.push(entry);
        }

        for (const c of contributions) {
          if (c.dedupeKey) {
            // If this key exists, skip (already emitted from stored entries above).
            // If the key doesn't exist, store this contribution.
            if (!dedupeMap.has(c.dedupeKey)) {
              const entry: CollectedContribution = {
                providerId: provider.id,
                text: c.text,
                placement: c.placement,
                order: c.order ?? 100,
                summary: c.summary,
                artifacts: c.referencedArtifacts,
              };
              dedupeMap.set(c.dedupeKey, entry);
              collected.push(entry);
            }
          } else {
            collected.push({
              providerId: provider.id,
              text: c.text,
              placement: c.placement,
              order: c.order ?? 100,
              summary: c.summary,
              artifacts: c.referencedArtifacts,
            });
          }
        }

        this.#errorCounts.set(provider.id, 0);
      } catch (err) {
        this.#recordError(provider.id, err);
      }
    }

    collected.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.providerId.localeCompare(b.providerId);
    });

    // Prepend contributions are prepended in sorted order, which places higher
    // order groups closer to the top while preserving providerId tie-breaks.
    const prependColl: CollectedContribution[] = [];
    let prependGroup: CollectedContribution[] = [];
    let prependGroupOrder: number | undefined;
    for (const contribution of collected) {
      if (contribution.placement !== "prepend") continue;
      if (prependGroupOrder === undefined || contribution.order === prependGroupOrder) {
        prependGroup.push(contribution);
        prependGroupOrder = contribution.order;
        continue;
      }
      prependColl.unshift(...prependGroup);
      prependGroup = [contribution];
      prependGroupOrder = contribution.order;
    }
    if (prependGroup.length > 0) prependColl.unshift(...prependGroup);

    const appendColl = collected.filter((c) => c.placement === "append");

    const prepend: string[] = [];
    const append: string[] = [];
    const summaries: string[] = [];
    const artifacts: NonNullable<ContextContribution["referencedArtifacts"]> = [];

    for (const c of prependColl) {
      prepend.push(c.text);
      summaries.push(c.summary);
      if (c.artifacts) artifacts.push(...c.artifacts);
    }
    for (const c of appendColl) {
      append.push(c.text);
      summaries.push(c.summary);
      if (c.artifacts) artifacts.push(...c.artifacts);
    }

    return { prepend, append, summaries, artifacts };
  }

  async onSessionStart(event: SessionStartEvent, ctx: ProviderContext): Promise<void> {
    for (const provider of this.#providers) {
      if (this.#disabled.has(provider.id)) continue;
      if (!isLifecycleHook(provider)) continue;
      if (!provider.onSessionStart) continue;
      try {
        await provider.onSessionStart(event, ctx);
      } catch (err) {
        this.#recordError(provider.id, err);
      }
    }
  }

  async onSessionShutdown(event: SessionShutdownEvent, ctx: ProviderContext): Promise<void> {
    for (const provider of this.#providers) {
      if (!isLifecycleHook(provider)) continue;
      if (!provider.onSessionShutdown) continue;
      try {
        await provider.onSessionShutdown(event, ctx);
      } catch {
        // Silent — we're shutting down
      }
    }
  }

  async onTurnEnd(event: TurnEndEvent, ctx: ProviderContext): Promise<void> {
    for (const provider of this.#providers) {
      if (this.#disabled.has(provider.id)) continue;
      if (!isLifecycleHook(provider)) continue;
      if (!provider.onTurnEnd) continue;
      try {
        await provider.onTurnEnd(event, ctx);
        this.#errorCounts.set(provider.id, 0);
      } catch (err) {
        this.#recordError(provider.id, err);
      }
    }
  }

  async onSessionClose(event: SessionCloseEvent, ctx: ProviderContext): Promise<SessionCloseResult | null> {
    for (const provider of this.#providers) {
      if (this.#disabled.has(provider.id)) continue;
      if (!isLifecycleHook(provider)) continue;
      if (!provider.onSessionClose) continue;
      try {
        const result = await provider.onSessionClose(event, ctx);
        if (result) return result;
      } catch (err) {
        this.#recordError(provider.id, err);
      }
    }
    return null;
  }

  #recordError(providerId: string, err: unknown): void {
    const count = (this.#errorCounts.get(providerId) ?? 0) + 1;
    this.#errorCounts.set(providerId, count);
    if (count >= MAX_CONSECUTIVE_ERRORS) {
      this.#disabled.add(providerId);
      console.error(
        `[ProviderBridge] Disabling provider "${providerId}" after ${count} consecutive errors:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
