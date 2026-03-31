export interface ViewerDebugEvent {
  id: number;
  at: number;
  source: string;
  type: string;
  payload?: unknown;
}

const MAX_EVENTS = 500;
let nextId = 1;
let events: ViewerDebugEvent[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeViewerDebugEvents(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getViewerDebugEvents(): ViewerDebugEvent[] {
  return events;
}

export function recordViewerDebugEvent(input: {
  source: string;
  type: string;
  payload?: unknown;
}): void {
  events = [
    ...events,
    {
      id: nextId++,
      at: Date.now(),
      source: input.source,
      type: input.type,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    },
  ].slice(-MAX_EVENTS);
  emit();
}

export function clearViewerDebugEvents(): void {
  events = [];
  emit();
}
