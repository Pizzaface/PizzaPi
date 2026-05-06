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
