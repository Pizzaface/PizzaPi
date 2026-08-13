package dev.pizzapi.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.content.Context;
import android.util.Log;

import androidx.core.content.ContextCompat;

/**
 * Capacitor plugin bridging the JS side to {@link NtfyForegroundService}.
 *
 * <p>JS usage (via {@code registerPlugin("PizzapiNtfy")}):
 * <pre>
 *   PizzapiNtfy.start({ ntfyUrl, topic, token? })
 *   PizzapiNtfy.stop()
 *   PizzapiNtfy.addListener("notificationTapped", ({ sessionId }) =&gt; ...)
 * </pre>
 *
 * <p>{@code notificationTapped} is emitted by {@link MainActivity} when it
 * receives the {@link #EXTRA_SESSION_ID} extra from a session notification's
 * explicit tap intent (see {@code NtfyForegroundService#buildTapIntent}).
 * Uses Capacitor's {@code notifyListeners(..., retainUntilConsumed=true)} so
 * a cold-start tap (intent delivered before the JS listener registers) is
 * held and replayed to the first listener that attaches — no separate
 * pending-tap plumbing needed.
 */
@CapacitorPlugin(name = "PizzapiNtfy")
public class NtfyPushPlugin extends Plugin {

    private static final String TAG = "PizzapiNtfyPlugin";

    /** Intent extra (set by NtfyForegroundService, read by MainActivity) carrying the tapped session id. */
    static final String EXTRA_SESSION_ID = "pizzapi.sessionId";

    @PluginMethod
    public void start(PluginCall call) {
        String ntfyUrl = call.getString("ntfyUrl");
        String topic = call.getString("topic");
        String token = call.getString("token"); // nullable; Phase 1 uses topic-as-secret

        if (ntfyUrl != null) ntfyUrl = ntfyUrl.trim();
        if (topic != null) topic = topic.trim();
        if (token != null) token = token.trim();

        if (ntfyUrl == null || ntfyUrl.isEmpty()) {
            call.reject("ntfyUrl is required");
            return;
        }
        if (topic == null || topic.isEmpty()) {
            call.reject("topic is required");
            return;
        }

        try {
            Context ctx = getContext();
            NtfyForegroundService.start(ctx, ntfyUrl, topic, token);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "failed to start ntfy foreground service", e);
            call.reject("Failed to start ntfy service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            NtfyForegroundService.stop(getContext());
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "failed to stop ntfy foreground service", e);
            call.reject("Failed to stop ntfy service: " + e.getMessage());
        }
    }

    /**
     * Called by {@link MainActivity} when a notification tap intent carrying
     * {@link #EXTRA_SESSION_ID} is delivered (cold start via onCreate, or warm
     * start via onNewIntent). retainUntilConsumed=true means: if the JS
     * listener hasn't attached yet, Capacitor holds the event and replays it
     * to the first listener that calls addListener("notificationTapped").
     */
    void notifySessionTap(String sessionId) {
        JSObject data = new JSObject();
        data.put("sessionId", sessionId);
        notifyListeners("notificationTapped", data, true);
    }
}