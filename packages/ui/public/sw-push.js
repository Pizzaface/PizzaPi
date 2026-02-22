/**
 * PizzaPi WebPush notification handler.
 * Loaded by the Workbox service worker via importScripts.
 */

self.addEventListener("push", function (event) {
    if (!event.data) return;

    var payload;
    try {
        payload = event.data.json();
    } catch (e) {
        payload = { title: "PizzaPi", body: event.data.text() };
    }

    var title = payload.title || "PizzaPi";
    var body = payload.body || "";
    var tag = payload.sessionId
        ? "pizzapi-" + (payload.type || "notification") + "-" + payload.sessionId
        : "pizzapi-" + (payload.type || "notification");

    var options = {
        body: body,
        icon: "/pwa-192x192.png",
        badge: "/pwa-64x64.png",
        tag: tag,
        renotify: true,
        data: {
            sessionId: payload.sessionId,
            type: payload.type,
            url: payload.sessionId ? "/" : "/",
        },
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
    event.notification.close();

    var data = event.notification.data || {};
    var sessionId = data.sessionId;

    event.waitUntil(
        self.clients
            .matchAll({ type: "window", includeUncontrolled: true })
            .then(function (windowClients) {
                // Focus an existing PizzaPi window and tell it to open the session
                for (var i = 0; i < windowClients.length; i++) {
                    var client = windowClients[i];
                    if ("focus" in client) {
                        client.focus();
                        if (sessionId) {
                            client.postMessage({ type: "open-session", sessionId: sessionId });
                        }
                        return;
                    }
                }
                // No window open — open a new one (app will auto-restore last session)
                return self.clients.openWindow("/");
            }),
    );
});
