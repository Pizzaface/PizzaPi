/**
 * PizzaPiNavContext — intercepts `pizzapi://` URLs for in-app navigation.
 *
 * Supported URL patterns:
 * - pizzapi://panel/{serviceId}        — open/toggle a service panel
 * - pizzapi://panel/{serviceId}#frag   — open panel + pass hash fragment to iframe
 * - pizzapi://session/{sessionId}      — navigate to a session
 */
import { createContext, useCallback, useContext, type ReactNode } from "react";

const SCHEME = "pizzapi://";

export interface PizzaPiNavActions {
  toggleServicePanel: (serviceId: string) => void;
  setActiveSessionId: (sessionId: string) => void;
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

interface PizzaPiNavProviderProps {
  actions: PizzaPiNavActions;
  children: ReactNode;
}

export function PizzaPiNavProvider({ actions, children }: PizzaPiNavProviderProps) {
  const navigate = useCallback(
    (url: string): boolean => {
      if (!url.startsWith(SCHEME)) return false;

      // Parse: strip scheme, split on # for fragment
      const rest = url.slice(SCHEME.length);
      const hashIdx = rest.indexOf("#");
      const path = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
      // fragment kept for future iframe hash forwarding
      // const fragment = hashIdx >= 0 ? rest.slice(hashIdx + 1) : undefined;

      const segments = path.split("/").filter(Boolean);
      const [action, ...idParts] = segments;
      const id = idParts.join("/");

      switch (action) {
        case "panel":
          if (id) {
            actions.toggleServicePanel(id);
            return true;
          }
          return false;

        case "session":
          if (id) {
            actions.setActiveSessionId(id);
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
