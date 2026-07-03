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
 * </pre>
 *
 * <p>Prototype (Phase 2): start/stop only. No JS event callbacks yet
 * (notificationTapped / connectionState) — the service posts notifications
 * directly. Event callbacks are a Phase 3 refinement (needs a static bridge
 * or bound service).
 */
@CapacitorPlugin(name = "PizzapiNtfy")
public class NtfyPushPlugin extends Plugin {

    private static final String TAG = "PizzapiNtfyPlugin";

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
}