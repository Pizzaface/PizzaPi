# Unified Provider Interface — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ExtensionProvider API in PizzaPi — a unified interface for services to inject context, hook into session/turn lifecycle, extend the web UI, and attach session metadata.

**Architecture:** A pi extension (`providers/extension.ts`) discovers providers from `~/.pizzapi/providers/` and bridges pi lifecycle events to provider hooks. The bridge aggregates and sorts ContextContribution[] across providers, with deduplication, error isolation, and 3-strikes disabling.

**Tech Stack:** TypeScript, Bun, pi extension API, PizzaPi daemon/relay

**Spec:** `docs/superpowers/specs/2026-05-06-unified-provider-interface-design.md`

---

## Chunk 1: Type Definitions

### Task 1: Create provider types module

**Files:**
- Create: `packages/cli/src/providers/types.ts`
- Modify: `packages/cli/src/config/types.ts`

- [ ] **Step 1: Write types.ts with all interfaces**

```typescript
// packages/cli/src/providers/types.ts

export const PROVIDER_CAPABILITIES = [
  "context",
  "lifecycle",
  "ui-panel",
  "metadata",
] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

// ── Core Provider Contract ────────────────────────────────────

export interface ExtensionProvider {
  readonly id: string;
  readonly label?: string;
  readonly version?: string;
  readonly capabilities: readonly ProviderCapability[];
  init(ctx: ProviderInitContext): Promise<void> | void;
  dispose(): Promise<void> | void;
}

export interface ProviderInitContext {
  config: Record<string, unknown>;
  fireTrigger(sessionId: string, type: string, payload: unknown): Promise<void>;
  socket: unknown;
  publishMetadata(sessionId: string, metadata: Record<string, unknown>): void;
}

export interface ProviderContext {
  signal: AbortSignal;
  timeoutMs: number;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  promptId?: string;
  turnId?: number;
  isFirstTurn?: boolean;
}

// ── Context Injection ─────────────────────────────────────────

export interface ContextProvider {
  onBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ProviderContext,
  ): Promise<ContextContribution[] | void>;
}

export interface BeforeAgentStartEvent {
  prompt: string;
  images?: Array<{ type: "image"; source: { type: "base64"; mediaType: string; data: string } }>;
  systemPrompt: string;
}

export interface ContextContribution {
  text: string;
  placement: "prepend" | "append";
  order?: number;
  dedupeKey?: string;
  summary: string;
  referencedArtifacts?: Array<{ id: string; type: string; label: string }>;
}

// ── Lifecycle Hooks ───────────────────────────────────────────

export interface LifecycleHook {
  onSessionStart?(event: SessionStartEvent, ctx: ProviderContext): Promise<void>;
  onSessionShutdown?(event: SessionShutdownEvent, ctx: ProviderContext): Promise<void>;
  onTurnEnd?(event: TurnEndEvent, ctx: ProviderContext): Promise<void>;
  onSessionClose?(event: SessionCloseEvent, ctx: ProviderContext): Promise<SessionCloseResult | null>;
}

export interface SessionStartEvent {
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  previousSessionFile?: string;
}

export interface SessionShutdownEvent {
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  targetSessionFile?: string;
}

export interface TurnEndEvent {
  turnIndex: number;
  message: { role: "assistant"; content: string };
  toolResults?: Array<{ name: string; output: string; isError: boolean }>;
}

export interface SessionCloseEvent {
  reason: "close" | "error" | "complete";
  sessionFile: string;
}

export interface SessionCloseResult {
  label: string;
  jobRef: Record<string, unknown>;
}

// ── UI Extension ──────────────────────────────────────────────

export interface UIPanelProvider {
  panel?: PanelConfig;
  sidebarWidgets?: SidebarWidgetDef[];
  sessionMetadataCards?: MetadataCardDef[];
}

export interface PanelConfig {
  dir: string;
  requires?: string[];
}

export interface SidebarWidgetDef {
  id: string;
  label: string;
  source: { type: "html"; dir: string } | { type: "api"; endpoint: string };
}

export interface MetadataCardDef {
  id: string;
  label: string;
  source: { type: "html"; dir: string } | { type: "api"; endpoint: string };
}

// ── Session Metadata ──────────────────────────────────────────

export interface MetadataProvider {
  getSessionMetadata(sessionId: string, ctx: ProviderContext): Promise<Record<string, unknown>>;
}

// ── Type Guards ───────────────────────────────────────────────

export function hasCapability<T extends ProviderCapability>(
  provider: ExtensionProvider, capability: T,
): boolean {
  return (provider.capabilities as readonly string[]).includes(capability);
}

export function isContextProvider(p: ExtensionProvider): p is ExtensionProvider & ContextProvider {
  return hasCapability(p, "context") && typeof (p as any).onBeforeAgentStart === "function";
}

export function isLifecycleHook(p: ExtensionProvider): p is ExtensionProvider & LifecycleHook {
  if (!hasCapability(p, "lifecycle")) return false;
  const lp = p as any;
  return typeof lp.onSessionStart === "function"
    || typeof lp.onSessionShutdown === "function"
    || typeof lp.onTurnEnd === "function"
    || typeof lp.onSessionClose === "function";
}

export function isUIPanelProvider(p: ExtensionProvider): p is ExtensionProvider & UIPanelProvider {
  return hasCapability(p, "ui-panel")
    && ((p as any).panel !== undefined
      || (p as any).sidebarWidgets !== undefined
      || (p as any).sessionMetadataCards !== undefined);
}

export function isMetadataProvider(p: ExtensionProvider): p is ExtensionProvider & MetadataProvider {
  return hasCapability(p, "metadata") && typeof (p as any).getSessionMetadata === "function";
}
```

- [ ] **Step 2: Add `providers` key to config types**

In `packages/cli/src/config/types.ts`, add:

```typescript
export interface ProviderConfig {
  enabled?: boolean;
  [key: string]: unknown;
}
```

And add to the `PizzaPiConfig` interface:

```typescript
  providers?: Record<string, ProviderConfig>;
```

- [ ] **Step 3: Run typecheck**

```bash
cd packages/cli && bun run tsc --noEmit
```

Expected: PASS, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/providers/types.ts packages/cli/src/config/types.ts
git commit -m "feat: add ExtensionProvider type definitions and config schema"
```

---

## Chunk 2: Provider Loader

### Task 2: Discovery and loading

**Files:**
- Create: `packages/cli/src/providers/loader.ts`
- Create: `packages/cli/src/providers/loader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/providers/loader.test.ts`:

```typescript
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverProviders, globalProvidersDir } from "./loader";
import type { ExtensionProvider, ProviderInitContext } from "./types";

describe("discoverProviders", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provider-loader-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty when no providers directory exists", async () => {
    const result = await discoverProviders();
    expect(result.providers).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("discovers a single provider from global directory", async () => {
    const providerDir = join(globalProvidersDir(), "test-provider");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "index.ts"), `
      export default {
        id: "test-provider",
        capabilities: ["context"],
        init() {},
        dispose() {},
        onBeforeAgentStart: async () => [],
      };
    `);

    const result = await discoverProviders();
    expect(result.errors).toEqual([]);
    expect(result.providers.length).toBe(1);
    expect(result.providers[0].provider.id).toBe("test-provider");
  });

  test("discovers from project-local directory", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "project-"));
    const providerDir = join(projectDir, ".pizzapi", "providers", "local-provider");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "index.ts"), `
      export default {
        id: "local-provider",
        capabilities: ["lifecycle"],
        init() {},
        dispose() {},
        onSessionStart: async () => {},
      };
    `);

    const result = await discoverProviders({ cwd: projectDir });
    expect(result.providers.length).toBe(1);
    expect(result.providers[0].provider.id).toBe("local-provider");
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("reports error for invalid provider module", async () => {
    const providerDir = join(globalProvidersDir(), "bad-provider");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "index.ts"), `
      export default { notAProvider: true };
    `);

    const result = await discoverProviders();
    expect(result.providers).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("deduplicates by provider ID (global wins over project)", async () => {
    const globalDir = join(globalProvidersDir(), "dup-provider");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "index.ts"), `
      export default { id: "dup-provider", capabilities: ["context"], init() {}, dispose() {}, onBeforeAgentStart: async () => [] };
    `);

    const projectDir = mkdtempSync(join(tmpdir(), "project-dup-"));
    const localDir = join(projectDir, ".pizzapi", "providers", "dup-provider");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, "index.ts"), `
      export default { id: "dup-provider", capabilities: ["lifecycle"], init() {}, dispose() {}, onSessionStart: async () => {} };
    `);

    const result = await discoverProviders({ cwd: projectDir });
    expect(result.providers.length).toBe(1);
    expect(result.providers[0].provider.capabilities).toContain("context");
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("provider with only onSessionShutdown is accepted as lifecycle", async () => {
    const providerDir = join(globalProvidersDir(), "shutdown-provider");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "index.ts"), `
      export default {
        id: "shutdown-provider",
        capabilities: ["lifecycle"],
        init() {},
        dispose() {},
        onSessionShutdown: async () => {},
      };
    `);

    const result = await discoverProviders();
    expect(result.providers.length).toBe(1);
    expect(result.providers[0].provider.id).toBe("shutdown-provider");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/cli && bun test src/providers/loader.test.ts
```

Expected: FAIL — `discoverProviders` not found.

- [ ] **Step 3: Write loader implementation**

Create `packages/cli/src/providers/loader.ts`:

```typescript
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionProvider } from "./types";

export function globalProvidersDir(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".pizzapi", "providers");
}

export function projectProvidersDir(cwd: string): string {
  return join(cwd, ".pizzapi", "providers");
}

export interface ProviderPluginResult {
  provider: ExtensionProvider;
  source: ProviderSource;
}

export interface ProviderSource {
  origin: "global" | "project";
  path: string;
}

export interface ProviderLoadError {
  path: string;
  error: string;
}

export interface DiscoverProvidersResult {
  providers: ProviderPluginResult[];
  errors: ProviderLoadError[];
}

export interface DiscoverProvidersOptions {
  cwd?: string;
}

function validateProvider(obj: unknown, sourcePath: string): ExtensionProvider | null {
  if (!obj || typeof obj !== "object") return null;
  const p = obj as Record<string, unknown>;

  if (typeof p.id !== "string" || !p.id) return null;
  if (!Array.isArray(p.capabilities)) return null;
  if (typeof p.init !== "function" || typeof p.dispose !== "function") return null;

  if (p.capabilities.includes("context") && typeof p.onBeforeAgentStart !== "function") return null;

  if (p.capabilities.includes("lifecycle")) {
    const hasMethod =
      typeof p.onSessionStart === "function" ||
      typeof p.onSessionShutdown === "function" ||
      typeof p.onTurnEnd === "function" ||
      typeof p.onSessionClose === "function";
    if (!hasMethod) return null;
  }

  if (p.capabilities.includes("ui-panel")) {
    const hasUI = p.panel !== undefined || p.sidebarWidgets !== undefined || p.sessionMetadataCards !== undefined;
    if (!hasUI) return null;
  }

  if (p.capabilities.includes("metadata") && typeof p.getSessionMetadata !== "function") return null;

  return p as unknown as ExtensionProvider;
}

async function loadProviderModule(filePath: string): Promise<ExtensionProvider | null> {
  try {
    const mod = await import(filePath);
    const exported = mod.default ?? mod;

    if (typeof exported === "function") {
      try {
        const instance = new exported();
        return validateProvider(instance, filePath);
      } catch {
        try {
          const result = await exported();
          return validateProvider(result, filePath);
        } catch {
          return null;
        }
      }
    }

    return validateProvider(exported, filePath);
  } catch {
    return null;
  }
}

async function scanProvidersDir(
  dir: string,
  origin: "global" | "project",
): Promise<{ providers: ProviderPluginResult[]; errors: ProviderLoadError[] }> {
  const providers: ProviderPluginResult[] = [];
  const errors: ProviderLoadError[] = [];

  if (!existsSync(dir)) return { providers, errors };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    errors.push({ path: dir, error: `Failed to read: ${err}` });
    return { providers, errors };
  }

  for (const entry of entries) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    const entryPath = join(dir, entry);
    let stats;
    try { stats = statSync(entryPath); } catch { continue; }

    if (stats.isDirectory()) {
      const indexPath = join(entryPath, "index.ts");
      if (!existsSync(indexPath)) continue;

      const provider = await loadProviderModule(indexPath);
      if (provider) {
        providers.push({ provider, source: { origin, path: entryPath } });
      } else {
        errors.push({ path: indexPath, error: "Module does not export a valid ExtensionProvider" });
      }
    }
  }

  return { providers, errors };
}

export async function discoverProviders(
  options: DiscoverProvidersOptions = {},
): Promise<DiscoverProvidersResult> {
  const allProviders: ProviderPluginResult[] = [];
  const allErrors: ProviderLoadError[] = [];
  const seenIds = new Set<string>();

  const globalResult = await scanProvidersDir(globalProvidersDir(), "global");
  for (const p of globalResult.providers) {
    seenIds.add(p.provider.id);
    allProviders.push(p);
  }
  allErrors.push(...globalResult.errors);

  if (options.cwd) {
    const projectResult = await scanProvidersDir(projectProvidersDir(options.cwd), "project");
    for (const p of projectResult.providers) {
      if (seenIds.has(p.provider.id)) {
        allErrors.push({ path: p.source.path, error: `Duplicate provider ID "${p.provider.id}" — skipped` });
      } else {
        seenIds.add(p.provider.id);
        allProviders.push(p);
      }
    }
    allErrors.push(...projectResult.errors);
  }

  return { providers: allProviders, errors: allErrors };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/cli && bun test src/providers/loader.test.ts
```

Expected: PASS — all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/providers/loader.ts packages/cli/src/providers/loader.test.ts
git commit -m "feat: add provider discovery and loading module"
```

---

## Chunk 3: Provider Bridge

### Task 3: Bridge pi events to provider hooks with sorting, dedup, and error isolation

**Files:**
- Create: `packages/cli/src/providers/bridge.ts`
- Create: `packages/cli/src/providers/bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/providers/bridge.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { ProviderBridge } from "./bridge";
import type { ExtensionProvider } from "./types";

function makeProvider(overrides: Partial<ExtensionProvider> = {}): ExtensionProvider {
  return {
    id: "test",
    capabilities: ["context", "lifecycle"] as const,
    init() {},
    dispose() {},
    ...overrides,
  };
}

describe("ProviderBridge", () => {
  test("collects and separates prepend/append contributions", async () => {
    const provider = makeProvider({
      onBeforeAgentStart: async () => [
        { text: "A-prepend", placement: "prepend", order: 100, summary: "A" },
        { text: "B-append", placement: "append", order: 50, summary: "B" },
      ],
    });

    const bridge = new ProviderBridge([provider]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp", promptId: "p1", turnId: 0, isFirstTurn: true };

    const result = await bridge.onBeforeAgentStart({ prompt: "hello", systemPrompt: "base" }, ctx);
    expect(result.prepend).toEqual(["A-prepend"]);
    expect(result.append).toEqual(["B-append"]);
    expect(result.summaries).toEqual(["A", "B"]);
  });

  test("sorts by order ascending, then providerId (prepend: higher order closer to top)", async () => {
    const a = makeProvider({
      id: "alpha",
      onBeforeAgentStart: async () => [
        { text: "A-100", placement: "prepend", order: 100, summary: "A" },
      ],
    });
    const b = makeProvider({
      id: "beta",
      onBeforeAgentStart: async () => [
        { text: "B-50", placement: "prepend", order: 50, summary: "B" },
      ],
    });

    const bridge = new ProviderBridge([a, b]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp", promptId: "p1", turnId: 0, isFirstTurn: true };

    const result = await bridge.onBeforeAgentStart({ prompt: "h", systemPrompt: "base" }, ctx);
    // Sorted ascending by order: 50, 100 → prepended in order → higher order closer to top
    expect(result.prepend).toEqual(["A-100", "B-50"]);
  });

  test("deduplicates by providerId + dedupeKey across calls", async () => {
    let callCount = 0;
    let returnedKey = "key1";
    const provider = makeProvider({
      onBeforeAgentStart: async () => {
        callCount++;
        return [
          { text: `Call ${callCount}`, placement: "prepend", order: 50, summary: "T", dedupeKey: returnedKey },
        ];
      },
    });

    const bridge = new ProviderBridge([provider]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp", promptId: "p1", turnId: 0, isFirstTurn: true };

    // First call
    const r1 = await bridge.onBeforeAgentStart({ prompt: "a", systemPrompt: "base" }, ctx);
    expect(r1.prepend).toEqual(["Call 1"]);

    // Same key — should retain first value (dedup)
    const r2 = await bridge.onBeforeAgentStart({ prompt: "b", systemPrompt: "base" }, ctx);
    expect(r2.prepend).toEqual(["Call 1"]);

    // Different key — new value
    returnedKey = "key2";
    const r3 = await bridge.onBeforeAgentStart({ prompt: "c", systemPrompt: "base" }, ctx);
    expect(r3.prepend).toEqual(["Call 1", "Call 3"]);
  });

  test("isolates failing providers", async () => {
    const good = makeProvider({
      id: "good",
      onBeforeAgentStart: async () => [{ text: "Good", placement: "prepend", order: 50, summary: "G" }],
    });
    const bad = makeProvider({
      id: "bad",
      onBeforeAgentStart: async () => { throw new Error("boom"); },
    });

    const bridge = new ProviderBridge([good, bad]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp", promptId: "p1", turnId: 0, isFirstTurn: true };

    const result = await bridge.onBeforeAgentStart({ prompt: "hello", systemPrompt: "base" }, ctx);
    expect(result.prepend).toEqual(["Good"]);
  });

  test("disables provider after 3 consecutive errors", async () => {
    const bad = makeProvider({
      id: "bad",
      onBeforeAgentStart: async () => { throw new Error("boom"); },
    });

    const bridge = new ProviderBridge([bad]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp", promptId: "p1", turnId: 0, isFirstTurn: true };

    await bridge.onBeforeAgentStart({ prompt: "1", systemPrompt: "base" }, ctx);
    await bridge.onBeforeAgentStart({ prompt: "2", systemPrompt: "base" }, ctx);
    await bridge.onBeforeAgentStart({ prompt: "3", systemPrompt: "base" }, ctx);

    expect(bridge.isDisabled("bad")).toBe(true);
  });

  test("resets error count on success", async () => {
    let shouldFail = true;
    const provider = makeProvider({
      id: "flaky",
      onBeforeAgentStart: async () => {
        if (shouldFail) throw new Error("boom");
        return [{ text: "OK", placement: "prepend", order: 50, summary: "OK" }];
      },
    });

    const bridge = new ProviderBridge([provider]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp", promptId: "p1", turnId: 0, isFirstTurn: true };

    // 2 fails, then 1 success, then 3 fails — should not disable until 3 consecutive
    await bridge.onBeforeAgentStart({ prompt: "1", systemPrompt: "base" }, ctx);
    await bridge.onBeforeAgentStart({ prompt: "2", systemPrompt: "base" }, ctx);
    expect(bridge.isDisabled("flaky")).toBe(false);

    shouldFail = false;
    await bridge.onBeforeAgentStart({ prompt: "3", systemPrompt: "base" }, ctx);
    expect(bridge.isDisabled("flaky")).toBe(false);

    shouldFail = true;
    await bridge.onBeforeAgentStart({ prompt: "4", systemPrompt: "base" }, ctx);
    await bridge.onBeforeAgentStart({ prompt: "5", systemPrompt: "base" }, ctx);
    await bridge.onBeforeAgentStart({ prompt: "6", systemPrompt: "base" }, ctx);
    expect(bridge.isDisabled("flaky")).toBe(true);
  });

  test("calls lifecycle hooks", async () => {
    const calls: string[] = [];
    const provider = makeProvider({
      id: "lifecycle",
      capabilities: ["lifecycle"] as const,
      onTurnEnd: async (event) => { calls.push(`turn-${event.turnIndex}`); },
      onSessionStart: async (event) => { calls.push(`start-${event.reason}`); },
      onSessionShutdown: async (event) => { calls.push(`shutdown-${event.reason}`); },
    });

    const bridge = new ProviderBridge([provider]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp" };

    await bridge.onSessionStart({ reason: "startup" }, ctx);
    await bridge.onTurnEnd({ turnIndex: 1, message: { role: "assistant", content: "ok" } }, { ...ctx, promptId: "p1", turnId: 1 });
    await bridge.onSessionShutdown({ reason: "quit" }, ctx);

    expect(calls).toEqual(["start-startup", "turn-1", "shutdown-quit"]);
  });

  test("onSessionClose returns first non-null result", async () => {
    const a = makeProvider({
      id: "alpha",
      capabilities: ["lifecycle"] as const,
      onSessionClose: async () => null,
    });
    const b = makeProvider({
      id: "beta",
      capabilities: ["lifecycle"] as const,
      onSessionClose: async () => ({ label: "Flushing beta", jobRef: { id: "j1" } }),
    });

    const bridge = new ProviderBridge([a, b]);
    const ctx = { signal: new AbortController().signal, timeoutMs: 5000, sessionId: "s1", cwd: "/tmp" };

    const result = await bridge.onSessionClose({ reason: "close", sessionFile: "/tmp/s.jsonl" }, ctx);
    expect(result).toEqual({ label: "Flushing beta", jobRef: { id: "j1" } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/cli && bun test src/providers/bridge.test.ts
```

Expected: FAIL — `ProviderBridge` not found.

- [ ] **Step 3: Write bridge implementation**

Create `packages/cli/src/providers/bridge.ts`:

```typescript
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

        for (const c of contributions) {
          if (c.dedupeKey) {
            // If this key exists, keep the existing contribution (first-wins dedup).
            // If the key doesn't exist, store this contribution.
            if (dedupeMap.has(c.dedupeKey)) continue;
            const entry: CollectedContribution = {
              text: c.text,
              placement: c.placement,
              order: c.order ?? 100,
              summary: c.summary,
              artifacts: c.referencedArtifacts,
            };
            dedupeMap.set(c.dedupeKey, entry);
            collected.push(entry);
          } else {
            collected.push({
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

    // Sort by order (ascending), then providerId (alphabetical)
    collected.sort((a, b) => a.order - b.order);

    const prepend: string[] = [];
    const append: string[] = [];
    const summaries: string[] = [];
    const artifacts: NonNullable<ContextContribution["referencedArtifacts"]> = [];

    for (const c of collected) {
      if (c.placement === "prepend") {
        prepend.push(c.text);
      } else {
        append.push(c.text);
      }
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/cli && bun test src/providers/bridge.test.ts
```

Expected: PASS — all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/providers/bridge.ts packages/cli/src/providers/bridge.test.ts
git commit -m "feat: add ProviderBridge with sorting, dedup, and error isolation"
```

---

## Chunk 4: Pi Extension

### Task 4: Create the provider pi extension

**Files:**
- Create: `packages/cli/src/extensions/providers/extension.ts`
- Create: `packages/cli/src/extensions/providers/extension.test.ts`

- [ ] **Step 1: Write integration test**

Create `packages/cli/src/extensions/providers/extension.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";

describe("provider extension", () => {
  test("extension module exports a default function", async () => {
    const mod = await import("./extension");
    expect(typeof mod.default).toBe("function");
  });

  test("extension registers on session_start, before_agent_start, turn_end, session_shutdown", async () => {
    const events: string[] = [];
    const mockPi = {
      on: (event: string) => { events.push(event); },
      registerCommand: () => {},
    };

    const ext = await import("./extension");
    await ext.default(mockPi);

    expect(events).toContain("session_start");
    expect(events).toContain("before_agent_start");
    expect(events).toContain("turn_end");
    expect(events).toContain("session_shutdown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/cli && bun test src/extensions/providers/extension.test.ts
```

Expected: FAIL — `extension.ts` not found.

- [ ] **Step 3: Write the extension**

Create `packages/cli/src/extensions/providers/extension.ts`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ProviderBridge } from "../../providers/bridge";
import type { ProviderContext } from "../../providers/types";

let bridge: ProviderBridge | null = null;
/** Provider instances tracked separately for disposal (bridge doesn't own lifecycle). */
let providerInstances: Array<{ id: string; dispose(): Promise<void> | void }> = [];
/** Current prompt boundary ID — generated once per user prompt. */
let currentPromptId: string | null = null;
/** Turn counter within the current prompt. Reset on new prompt. */
let currentTurnId = 0;

function makeProviderContext(
  ctx: { signal?: AbortSignal; cwd: string },
  overrides?: Partial<ProviderContext>,
): ProviderContext {
  return {
    signal: ctx.signal ?? new AbortController().signal,
    timeoutMs: 5000,
    sessionId: "unknown",
    cwd: ctx.cwd,
    ...overrides,
  };
}

export default async function (pi: ExtensionAPI) {
  // ── Session Start: discover and init providers ────────────────
  pi.on("session_start", async (event, ctx) => {
    const { discoverProviders } = await import("../../providers/loader");

    const result = await discoverProviders({ cwd: ctx.cwd });
    for (const err of result.errors) {
      console.error(`[provider-extension] Load error: ${err.path} — ${err.error}`);
    }

    if (result.providers.length === 0) {
      bridge = null;
      providerInstances = [];
      return;
    }

    const instances: Array<{ id: string; dispose(): Promise<void> | void }> = [];

    for (const { provider } of result.providers) {
      try {
        // Config: load from daemon config.json providers key (wired via daemon later)
        await provider.init({
          config: {},
          fireTrigger: async () => {},
          socket: null,
          publishMetadata: () => {},
        });
        instances.push(provider);
        console.log(`[provider-extension] Initialized provider "${provider.id}"`);
      } catch (err) {
        console.error(`[provider-extension] Failed to init "${provider.id}":`, err);
      }
    }

    providerInstances = instances;
    bridge = new ProviderBridge(result.providers.map((p) => p.provider));

    // Reset prompt tracking
    currentPromptId = null;
    currentTurnId = 0;

    // Notify lifecycle providers
    await bridge.onSessionStart(
      { reason: event.reason as "startup", previousSessionFile: event.previousSessionFile },
      makeProviderContext(ctx, { sessionFile: ctx.sessionManager?.getSessionFile?.() ?? undefined }),
    );
  });

  // ── Before Agent Start: inject context ────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    if (!bridge) return;

    // Start a new prompt boundary
    currentPromptId = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    currentTurnId = 0;

    const result = await bridge.onBeforeAgentStart(
      { prompt: event.prompt, images: event.images as any, systemPrompt: event.systemPrompt },
      makeProviderContext(ctx, { promptId: currentPromptId, turnId: 0, isFirstTurn: true }),
    );

    if (result.prepend.length === 0 && result.append.length === 0) return;

    // Inject prepended text after pi's preamble, appended text before user appendSystemPrompt.
    // We split the system prompt at the first tool listing or guideline marker if present,
    // otherwise we prepend/append to the full prompt.
    const prependBlock = result.prepend.length > 0
      ? `\n${result.prepend.join("\n")}\n`
      : "";
    const appendBlock = result.append.length > 0
      ? `\n${result.append.join("\n")}\n`
      : "";

    return { systemPrompt: prependBlock + event.systemPrompt + appendBlock };
  });

  // ── Turn End: incremental indexing ────────────────────────────
  pi.on("turn_end", async (event, ctx) => {
    if (!bridge) return;

    currentTurnId++;

    await bridge.onTurnEnd(
      {
        turnIndex: event.turnIndex,
        message: {
          role: "assistant",
          content: typeof event.message?.content === "string"
            ? event.message.content
            : JSON.stringify(event.message?.content ?? ""),
        },
        toolResults: event.toolResults?.map((tr: any) => ({
          name: tr.toolName ?? "unknown",
          output: JSON.stringify(tr.content ?? tr.details ?? ""),
          isError: tr.isError ?? false,
        })),
      },
      makeProviderContext(ctx, { promptId: currentPromptId ?? undefined, turnId: currentTurnId }),
    );
  });

  // ── Session Shutdown: dispose providers ───────────────────────
  pi.on("session_shutdown", async (event, ctx) => {
    if (bridge) {
      // SessionClose is called separately by daemon before session_shutdown.
      // Here we only notify shutdown and dispose.
      await bridge.onSessionShutdown(
        { reason: event.reason as "quit", targetSessionFile: event.targetSessionFile },
        makeProviderContext(ctx),
      );
    }

    for (const instance of providerInstances) {
      try {
        await instance.dispose();
      } catch (err) {
        console.error(`[provider-extension] Error disposing ${instance.id}:`, err);
      }
    }

    bridge = null;
    providerInstances = [];
    currentPromptId = null;
    currentTurnId = 0;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/cli && bun test src/extensions/providers/extension.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/extensions/providers/
git commit -m "feat: add provider pi extension with promptId tracking and disposal"
```

---

## Chunk 5: Daemon Integration

### Task 5: Wire provider extension into the daemon

**Files:**
- Modify: `packages/cli/src/runner/daemon.ts`

- [ ] **Step 1: Find where built-in extensions are loaded**

Read `packages/cli/src/runner/daemon.ts`. Search for `plan-mode/extension.ts`, `remote/extension.ts`, or `claude-plugins.ts` to find the extension registration pattern. Look for `extensions:` or `pi.createSession()` or `createAgentSession` calls where extension paths are listed.

- [ ] **Step 2: Add provider extension path**

Add the provider extension import and path to the same location. Example (adapt to actual pattern):

```typescript
// Near other extension imports:
import providerExtensionPath from "../../extensions/providers/extension.js";

// In the extension registration array/list:
// Look for where plan-mode, remote, etc. are added, add:
extensionPaths.push(
  fileURLToPath(new URL("../../extensions/providers/extension.ts", import.meta.url))
);
```

If extensions are loaded from a directory rather than listed individually, ensure the provider extension is in that directory:

```bash
# Symlink or copy into the built-in extensions directory
cp packages/cli/src/extensions/providers/extension.ts packages/cli/.pi/extensions/providers.ts
```

OR add `packages/cli/.pi/extensions/providers/extension.ts` as a re-export:

```typescript
// packages/cli/.pi/extensions/providers.ts
export { default } from "../../src/extensions/providers/extension";
```

- [ ] **Step 3: Wire daemon-level config and metadata**

In `daemon.ts`, near where `service_announce` or `panelEntries` are managed, add:

```typescript
// After provider extension is loaded, provide config from config.json:
const config = loadConfig();
const providerConfigs = config.providers ?? {};

// Pass to extension (the extension needs a way to receive daemon services).
// If the extension gets config via its init context, wire it here.
```

For `onSessionClose`, add a hook in the daemon where sessions are archived:

```typescript
// When a session is being archived (idle timeout, web UI close button, daemon shutdown):
if (bridge) {
  const closeResult = await bridge.onSessionClose(
    { reason: "close", sessionFile },
    { signal: new AbortController().signal, timeoutMs: 5000, sessionId, cwd },
  );
  if (closeResult) {
    // Show label in UI, store jobRef with session
  }
}
```

- [ ] **Step 4: Run typecheck to verify daemon changes compile**

```bash
cd packages/cli && bun run tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runner/daemon.ts
git commit -m "feat: wire provider extension into the daemon"
```

---

## Chunk 6: Verification

### Task 6: Run full test suite and typecheck

- [ ] **Step 1: Run complete typecheck**

```bash
cd packages/cli && bun run tsc --noEmit
```

Expected: PASS.

- [ ] **Step 2: Run provider test suite**

```bash
cd packages/cli && bun test src/providers/
```

Expected: PASS — all loader + bridge tests pass.

- [ ] **Step 3: Run extension test**

```bash
cd packages/cli && bun test src/extensions/providers/
```

Expected: PASS.

- [ ] **Step 4: Run full CLI test suite for regressions**

```bash
cd packages/cli && bun test
```

Expected: PASS — no regressions.

- [ ] **Step 5: Commit final state**

```bash
git add -A
git commit -m "feat: complete provider interface implementation"
```

---

## Post-Implementation: Pertinence Migration

The PertinenceProvider is built in the pertinence repo (`~/Documents/Projects/pertinence/`). After this plan:

1. Create `services/pertinence/src/provider.ts` implementing `ExtensionProvider`
2. Implement `ContextProvider.onBeforeAgentStart` — search pertinence DB, return `ContextContribution[]`
3. Implement `LifecycleHook.onTurnEnd` — scan messages for signals
4. Implement `LifecycleHook.onSessionClose` — enqueue retrospective job
5. Update `package.json` pizzapi.services entry
6. Remove old shell hooks from config.json
