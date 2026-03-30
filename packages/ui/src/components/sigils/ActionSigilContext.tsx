import { createContext, useContext, type ReactNode } from "react";

export interface ActionSigilRuntime {
  canInteract: boolean;
  isMessageComplete: boolean;
  sendResponse?: (text: string) => Promise<boolean>;
}

const ActionSigilContext = createContext<ActionSigilRuntime>({
  canInteract: false,
  isMessageComplete: false,
});

export function ActionSigilProvider({
  value,
  children,
}: {
  value: ActionSigilRuntime;
  children: ReactNode;
}) {
  return <ActionSigilContext.Provider value={value}>{children}</ActionSigilContext.Provider>;
}

export function useActionSigilRuntime() {
  return useContext(ActionSigilContext);
}
