export const BROWSER_INPUT_NOTIFICATION_TAG_PREFIX = "pizzapi-browser-input-";

export function getBrowserInputNotificationTag(sessionId: string): string {
  return `${BROWSER_INPUT_NOTIFICATION_TAG_PREFIX}${sessionId}`;
}

export function getOpenSessionMessageSessionId(messageData: unknown): string | null {
  if (!messageData || typeof messageData !== "object") return null;

  const data = messageData as { type?: unknown; sessionId?: unknown };
  if (data.type !== "open-session" || typeof data.sessionId !== "string") return null;

  return data.sessionId;
}

export async function showBrowserInputNotification(
  registration: Pick<ServiceWorkerRegistration, "showNotification">,
  sessionId: string,
  sessionLabel: string,
): Promise<void> {
  await registration.showNotification("Input needed", {
    body: `Agent in "${sessionLabel}" is waiting for your input.`,
    icon: "/pwa-192x192.png",
    tag: getBrowserInputNotificationTag(sessionId),
    data: {
      sessionId,
      type: "browser_input",
    },
  });
}

export async function closeBrowserInputNotification(sessionId: string): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const notifications = await registration.getNotifications({
      tag: getBrowserInputNotificationTag(sessionId),
    });
    for (const notification of notifications) {
      notification.close();
    }
  } catch {
    // Silently ignore — browser notifications are best-effort.
  }
}
