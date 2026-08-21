import type { TriggerSubscriptionDelta, TriggerSubscriptionEntry } from "@pizzapi/protocol";

/**
 * Narrow socket shape actually used by service handlers. Structurally
 * compatible with a socket.io-client `Socket`, but this package does not
 * depend on socket.io-client — hosts pass their real socket instance in.
 */
export interface PizzaPiSocket {
  on<Args extends unknown[]>(event: string, listener: (...args: Args) => void): unknown;
  off<Args extends unknown[]>(event: string, listener: (...args: Args) => void): unknown;
  emit<Args extends unknown[]>(event: string, ...args: Args): unknown;
}

/**
 * Interface for runner-side service handlers.
 * Each service registers its socket event handlers in init() and cleans up in dispose().
 */
export interface ServiceHandler {
  /** Unique service identifier (e.g., "terminal", "file-explorer", "git") */
  readonly id: string;

  /**
   * Initialize the service — register socket event listeners and perform setup.
   * Called once during daemon startup. Socket.IO reconnects reuse the same
   * Socket instance, so listeners remain attached across transient reconnects.
   */
  init(socket: PizzaPiSocket, options: ServiceInitOptions): void;

  /**
   * Clean up the service — kill processes, clear state, remove listeners.
   * Called on daemon shutdown.
   */
  dispose(): void;

  /**
   * Clean up any state tied to a specific session when that session ends.
   * Optional — services that don't manage per-session runtime state can skip it.
   */
  handleSessionEnded?(sessionId: string): void;

  /**
   * Reconcile in-memory subscription state against a full snapshot from the server.
   * Called after runner reconnection with the subset of subscriptions relevant to
   * this service's trigger types. Services that manage runtime state per subscription
   * (e.g. timers, watchers) should implement this to rebuild that state.
   *
   * Optional — services that don't manage per-subscription state can skip this.
   */
  reconcileSubscriptions?(subscriptions: TriggerSubscriptionEntry[], options?: ReconcileOptions): ReconcileResult;
}

/**
 * Result of a reconcileSubscriptions call.
 */
export interface ReconcileResult {
  /** Number of subscriptions successfully reconciled. */
  applied: number;
  /** Optional error messages for subscriptions that failed. */
  errors?: string[];
}

export interface ReconcileOptions {
  /** Full snapshot rebuild vs. single live delta application. */
  mode?: "snapshot" | "delta";
  /** Delta action when mode === "delta". */
  action?: TriggerSubscriptionDelta["action"];
}

export interface ServiceInitOptions {
  isShuttingDown: () => boolean;
  /** Call to announce a panel HTTP server port. Only provided to services with a panel manifest. */
  announcePanel?: (port: number) => void;
  /**
   * Call to announce an HTTP server that handles sigil resolve calls but has no UI panel.
   * The port is registered with the tunnel proxy for routing and stamped onto the service's
   * sigil definitions so the UI can reach it — but the service does NOT appear in the
   * panels list and is not shown in the services grid.
   */
  announceSigilServer?: (port: number) => void;
}

/**
 * Generic relay protocol envelope.
 * All service messages conceptually flow through this shape, even though
 * the actual socket events don't change in Phase 1 (relay unchanged).
 */
export interface ServiceEnvelope {
  serviceId: string;
  type: string;
  /** Host-stamped unique id for at-least-once delivery dedupe (`env.id`). */
  id?: string;
  requestId?: string;
  /** Attached by the relay when forwarding viewer→runner, so services can route responses back. */
  sessionId?: string;
  payload: unknown;
}

export type { TriggerSubscriptionEntry, TriggerSubscriptionDelta };
