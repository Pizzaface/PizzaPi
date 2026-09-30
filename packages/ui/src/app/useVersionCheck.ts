import * as React from "react";
import { SOCKET_PROTOCOL_VERSION } from "@pizzapi/protocol";
import { evaluateVersionNegotiation } from "@/lib/version-negotiation";
import { BUILD_TIMESTAMP, UI_VERSION } from "./constants";

/**
 * UI ↔ server version negotiation via `/health`. Runs once authenticated and
 * again on every hub reconnect (the caller invokes `checkVersionCompatibility`).
 */
export function useVersionCheck(session: unknown, isMobileBundled: boolean) {
  const [versionBanner, setVersionBanner] = React.useState<{ message: string | null; protocolCompatible: boolean }>({
    message: null,
    protocolCompatible: true,
  });

  const checkVersionCompatibility = React.useCallback(async () => {
    try {
      const res = await fetch("/health", { credentials: "include" });
      if (!res.ok) return;
      const payload: unknown = await res.json();
      const negotiation = evaluateVersionNegotiation(payload, {
        uiVersion: UI_VERSION,
        clientSocketProtocol: SOCKET_PROTOCOL_VERSION,
        uiBuildTimestamp: BUILD_TIMESTAMP,
        isMobileBundled,
      });
      setVersionBanner({
        message: negotiation.message,
        protocolCompatible: negotiation.protocolCompatible,
      });
    } catch {
      // Best effort only — do not surface transient fetch errors as hard failures.
    }
  }, [isMobileBundled]);

  React.useEffect(() => {
    if (!session) return;
    void checkVersionCompatibility();
  }, [session, checkVersionCompatibility]);

  return { versionBanner, checkVersionCompatibility };
}
