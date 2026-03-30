/**
 * PizzaPiNavContext — intercepts `pizzapi://` URLs for in-app navigation.
 *
 * Supported URL patterns:
 * - pizzapi://panel/{serviceId}                    — open/toggle a service panel
 * - pizzapi://panel/{serviceId}?key=val#frag       — open panel, forward query + hash to iframe
 * - pizzapi://session/{sessionId}                  — navigate to a session
 * - pizzapi://session/{sessionId}?tab=triggers     — navigate with query params
 *
 * Query parameters and hash fragments are preserved and passed to the
 * action handlers so they can forward them downstream (e.g. to panel iframes).
 */
import { createContext, useCallback, useContext, type ReactNode } from "react";

const SCHEME = "pizzapi://";

export interface PizzaPiNavActions {
  toggleServicePanel: (serviceId: string, query?: string, fragment?: string) => void;
  setActiveSessionId: (sessionId: string, query?: string, fragment?: string) => void;
}

type NavigateFn = (url: string) => boolean;

const PizzaPiNavCtx = createContext<NavigateFn>(() => false);

/** Returns a function that handles `pizzapi://` URLs. Returns true if handled. */
export function usePizzaPiNav(): NavigateFn {
  return useContext(PizzaPiNavCtx);
}

/** Returns true if the href uses the pizzapi:// scheme. */
export function isPizzaPiUrl(href: string | undefined): boolean {
  return !!href && href.startsWith(SCHEME);
}

/**
 * Parse a pizzapi:// URL into its components.
 *
 * Given: `pizzapi://panel/my-service?foo=bar#section`
 * Returns: { path: "panel/my-service", query: "foo=bar", fragment: "section" }
 */
export function parsePizzaPiUrl(url: string): {
  path: string;
  query: string | undefined;
  fragment: string | undefined;
} | null {
  if (!url.startsWith(SCHEME)) return null;

  const rest = url.slice(SCHEME.length);

  // Split off fragment (#) first, then query (?)
  // Order matters: "path?q=1#frag" → fragment="frag", then query="q=1"
  let path = rest;
  let fragment: string | undefined;
  let query: string | undefined;

  const hashIdx = path.indexOf("#");
  if (hashIdx >= 0) {
    fragment = path.slice(hashIdx + 1) || undefined;
    path = path.slice(0, hashIdx);
  }

  const queryIdx = path.indexOf("?");
  if (queryIdx >= 0) {
    query = path.slice(queryIdx + 1) || undefined;
    path = path.slice(0, queryIdx);
  }

  return { path, query, fragment };
}

interface PizzaPiNavProviderProps {
  actions: PizzaPiNavActions;
  children: ReactNode;
}

export function PizzaPiNavProvider({ actions, children }: PizzaPiNavProviderProps) {
  const navigate = useCallback(
    (url: string): boolean => {
      const parsed = parsePizzaPiUrl(url);
      if (!parsed) return false;

      const { path, query, fragment } = parsed;
      const segments = path.split("/").filter(Boolean);
      const [action, ...idParts] = segments;
      const id = idParts.join("/");

      switch (action) {
        case "panel":
          if (id) {
            actions.toggleServicePanel(id, query, fragment);
            return true;
          }
          return false;

        case "session":
          if (id) {
            actions.setActiveSessionId(id, query, fragment);
            return true;
          }
          return false;

        default:
          return false;
      }
    },
    [actions],
  );

  return <PizzaPiNavCtx.Provider value={navigate}>{children}</PizzaPiNavCtx.Provider>;
}
