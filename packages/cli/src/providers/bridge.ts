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

/**
 * Races a provider hook against `ctx.timeoutMs` and `ctx.signal`. Takes a
 * thunk (not an already-created promise) so an already-aborted signal skips
 * *invoking* the hook entirely instead of calling it and discarding the
 * result — promise arguments are evaluated eagerly in JS, so `withTimeout(p(),
 * ...)` would already have started `p()`'s side effects by the time the
 * abort check runs.
 *
 * Exported (not a private ProviderBridge method) so callers that invoke
 * provider hooks outside the bridge — e.g. the pi extension adapter's
 * `provider.init()`/`provider.dispose()`, which the bridge doesn't own — get
 * the exact same bounded-cancellation semantics instead of a bespoke copy.
 */
export async function withProviderTimeout<T>(
  fn: () => Promise<T>,
  ctx: ProviderContext,
  providerId: string,
): Promise<T> {
  if (ctx.signal.aborted) {
    throw new Error(`Provider "${providerId}" call aborted before execution`);
  }

  // A deadline is a shared budget for sequential provider hooks, not a fresh
  // timeout per provider.
  const remainingMs = ctx.deadline !== undefined ? ctx.deadline - Date.now() : ctx.timeoutMs;
  const effectiveTimeoutMs = Math.max(0, Math.min(ctx.timeoutMs, remainingMs));
  if (effectiveTimeoutMs === 0) {
    throw new Error(`Provider "${providerId}" call skipped: overall deadline already elapsed`);
  }

  const promise = fn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Provider "${providerId}" timed out after ${effectiveTimeoutMs}ms`));
    }, effectiveTimeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      ctx.signal.removeEventListener("abort", onAbort);
      reject(new Error(`Provider "${providerId}" call aborted`));
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, timeoutPromise, abortPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
        const contributions = await withProviderTimeout(
          () => provider.onBeforeAgentStart(event, ctx),
          ctx,
          provider.id,
        );
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
      const hook = provider.onSessionStart;
      if (!hook) continue;
      try {
        await withProviderTimeout(() => hook(event, ctx), ctx, provider.id);
      } catch (err) {
        this.#recordError(provider.id, err);
      }
    }
  }

  /**
   * Bounded by `ctx.timeoutMs`/`ctx.signal` via `withProviderTimeout`, same as
   * every other hook — a hung `onSessionShutdown` used to be able to hang the
   * whole shutdown path (dispose/reload/new/resume/quit) indefinitely.
   */
  async onSessionShutdown(event: SessionShutdownEvent, ctx: ProviderContext): Promise<void> {
    for (const provider of this.#providers) {
      if (!isLifecycleHook(provider)) continue;
      const hook = provider.onSessionShutdown;
      if (!hook) continue;
      try {
        await withProviderTimeout(() => hook(event, ctx), ctx, provider.id);
      } catch {
        // Silent — we're shutting down
      }
    }
  }

  async onTurnEnd(event: TurnEndEvent, ctx: ProviderContext): Promise<void> {
    for (const provider of this.#providers) {
      if (this.#disabled.has(provider.id)) continue;
      if (!isLifecycleHook(provider)) continue;
      const hook = provider.onTurnEnd;
      if (!hook) continue;
      try {
        await withProviderTimeout(() => hook(event, ctx), ctx, provider.id);
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
      const hook = provider.onSessionClose;
      if (!hook) continue;
      // Providers run sequentially; without this check N providers could add
      // up to N * timeoutMs of wall time. ctx.deadline (set by the caller,
      // e.g. runProviderSessionClose) is one overall budget for the whole
      // loop, not per provider — stop trying once it's gone.
      if (ctx.deadline !== undefined && Date.now() >= ctx.deadline) break;
      try {
        const result = await withProviderTimeout(() => hook(event, ctx), ctx, provider.id);
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
