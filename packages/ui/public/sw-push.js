/**
 * PizzaPi WebPush notification handler.
 * Loaded by the Workbox service worker via importScripts.
 *
 * Supports:
 * - Standard push notifications with icon/badge
 * - Action buttons for MC options (agent_needs_input)
 * - Inline text reply for custom answers
 * - Answering directly from the notification via POST /api/push/answer
 */

// Build absolute URLs for notification icons using the SW scope.
// This avoids browser-specific issues where relative paths don't resolve
// correctly and the browser falls back to its own icon (e.g. Brave icon).
function absoluteUrl(path) {
    // self.registration.scope is always an absolute URL ending with /
    var scope = self.registration.scope.replace(/\/$/, "");
    return scope + path;
}

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
        icon: absoluteUrl("/pwa-192x192.png"),
        badge: absoluteUrl("/pwa-64x64.png"),
        tag: tag,
        renotify: true,
        data: {
            sessionId: payload.sessionId,
            type: payload.type,
            options: payload.data && payload.data.options ? payload.data.options : null,
        },
    };

    // Add action buttons if provided (MC options from AskUserQuestion)
    if (Array.isArray(payload.actions) && payload.actions.length > 0) {
        options.actions = payload.actions.map(function (a) {
            var action = { action: a.action, title: a.title };
            if (a.type) action.type = a.type;
            if (a.placeholder) action.placeholder = a.placeholder;
            return action;
        });
        // Keep the notification visible until the user interacts with it
        options.requireInteraction = true;
    }

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
    event.notification.close();

    var data = event.notification.data || {};
    var sessionId = data.sessionId;
    var action = event.action; // which button was clicked
    var reply = event.reply; // text from inline reply (type: "text" action)

    // Determine the answer text based on what was clicked
    var answerText = null;
    if (reply && typeof reply === "string" && reply.trim()) {
        // User typed an inline reply
        answerText = reply.trim();
    } else if (action && action.startsWith("option-") && Array.isArray(data.options)) {
        // User clicked an option button — extract the option text
        var optIndex = parseInt(action.replace("option-", ""), 10);
        // Filter out "Type your own" entries to match the server's filtering
        var filtered = data.options.filter(function (o) {
            return typeof o === "string" && o.toLowerCase().replace(/[^a-z]/g, "") !== "typeyourown";
        });
        if (optIndex >= 0 && optIndex < filtered.length) {
            answerText = filtered[optIndex];
        }
    }

    // If we have an answer and a session, send it back to the server
    if (answerText && sessionId) {
        event.waitUntil(
            sendAnswerToServer(sessionId, answerText).then(function () {
                // Answer sent successfully — no need to open the app
            }).catch(function () {
                // Failed to send via API — fall back to opening the app
                return openAppToSession(sessionId);
            })
        );
        return;
    }

    // No answer action — just open/focus the app
    event.waitUntil(openAppToSession(sessionId));
});

/**
 * Send an answer to the server via the push answer API endpoint.
 * Uses fetch with credentials (session cookie) from the service worker.
 */
function sendAnswerToServer(sessionId, text) {
    return fetch(absoluteUrl("/api/push/answer"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId, text: text }),
    }).then(function (res) {
        if (!res.ok) throw new Error("Push answer failed: " + res.status);
        return res;
    });
}

/**
 * Focus an existing PizzaPi window and navigate to the session,
 * or open a new window if none exists.
 */
function openAppToSession(sessionId) {
    return self.clients
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
            // No window open — open a new one
            return self.clients.openWindow("/");
        });
}
