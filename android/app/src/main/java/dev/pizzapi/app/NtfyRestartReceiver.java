package dev.pizzapi.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.core.content.ContextCompat;

/**
 * Restarts {@link NtfyForegroundService} without any JS round-trip, using the
 * config persisted by the service itself. Two triggers:
 * <ul>
 *   <li>{@code BOOT_COMPLETED} — the process (and any prior FGS instance) is
 *       gone after a reboot; nothing else would ever start the service again.</li>
 *   <li>{@link #ACTION_RESTART} — fired by an AlarmManager one-shot that
 *       {@link NtfyForegroundService#scheduleRestart} sets, used both after an
 *       Android 15+ FGS-timeout and to retry a failed restart attempt.</li>
 * </ul>
 * Both are allowed exemptions to the Android 8+/12+ background-FGS-start
 * restrictions, so calling {@code startForegroundService()} here is safe as
 * long as the service promotes to foreground promptly (it does, first line of
 * {@code onStartCommand}).
 */
public class NtfyRestartReceiver extends BroadcastReceiver {

    private static final String TAG = "PizzapiNtfyRestart";

    static final String ACTION_RESTART = "dev.pizzapi.app.ACTION_RESTART_NTFY";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !ACTION_RESTART.equals(action)) {
            return;
        }
        if (!NtfyForegroundService.canAutoRestart(context)) {
            Log.i(TAG, "no persisted ntfy config or push disabled; not restarting");
            return;
        }
        try {
            ContextCompat.startForegroundService(context, new Intent(context, NtfyForegroundService.class));
        } catch (Exception e) {
            // Most likely ForegroundServiceStartNotAllowedException because the
            // dataSync FGS quota (see NtfyForegroundService#onTimeout) is still
            // exhausted. Retry later rather than leaving push dead forever.
            Log.w(TAG, "failed to restart ntfy service: " + e.getMessage() + "; retrying later");
            NtfyForegroundService.scheduleRestart(context);
        }
    }
}
