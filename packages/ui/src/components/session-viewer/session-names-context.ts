import { createContext, useContext } from "react";

/** sessionId → sessionName for live sessions (App-provided; empty in tests/snapshots). */
const SessionNamesContext = createContext<ReadonlyMap<string, string | null>>(new Map());

export const SessionNamesProvider = SessionNamesContext.Provider;

export function useSessionName(sessionId: string): string | null {
  return useContext(SessionNamesContext).get(sessionId)?.trim() || null;
}
