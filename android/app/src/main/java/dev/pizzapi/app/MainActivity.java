package dev.pizzapi.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the local ntfy foreground-service push plugin before the
        // bridge initializes. registerPlugin must be called before super.onCreate.
        registerPlugin(NtfyPushPlugin.class);
        super.onCreate(savedInstanceState);
        // Cold start: the launch intent may already carry a tapped-notification
        // session id (see NtfyForegroundService#buildTapIntent).
        handleTapIntent(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // The activity is singleTop, so a tap while already running arrives
        // here instead of onCreate. setIntent() so later getIntent() calls
        // (e.g. a future recreation) don't see this delivery again.
        setIntent(intent);
        handleTapIntent(intent);
    }

    /** If the intent carries a tapped session-notification id, forward it to the JS bridge. */
    private void handleTapIntent(Intent intent) {
        if (intent == null) return;
        String sessionId = intent.getStringExtra(NtfyPushPlugin.EXTRA_SESSION_ID);
        if (sessionId == null || sessionId.isEmpty()) return;
        // Prevent re-delivery if this same Intent object is inspected again later.
        intent.removeExtra(NtfyPushPlugin.EXTRA_SESSION_ID);

        PluginHandle handle = getBridge() != null ? getBridge().getPlugin("PizzapiNtfy") : null;
        if (handle != null && handle.getInstance() instanceof NtfyPushPlugin) {
            ((NtfyPushPlugin) handle.getInstance()).notifySessionTap(sessionId);
        }
    }
}
