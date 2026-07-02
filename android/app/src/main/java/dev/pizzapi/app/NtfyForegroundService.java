package dev.pizzapi.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Foreground service that holds a persistent ntfy subscribe stream so the
 * PizzaPi Android app can receive background push notifications WITHOUT
 * Google/FCM.
 *
 * <p>Reliability model:
 * <ul>
 *   <li>Config (ntfyUrl/topic/token) is persisted to SharedPreferences so a
 *       system-initiated restart (null intent) can reconnect instead of dying.</li>
 *   <li>A cursor (last-seen ntfy message {@code id}) is persisted; first connect
 *       uses {@code since=<install-time>}, later connects use {@code since=<lastId>}.
 *       An in-memory LRU of processed ids drops duplicates so reconnects don't
 *       re-notify history.</li>
 *   <li>Finite read timeout + response-code checks + jittered backoff; permanent
 *       4xx stop retrying and surface an error notification.</li>
 * </ul>
 *
 * <p>Known limitations (see deployment/mobile-push.mdx): no Doze wakelock, no
 * BOOT_COMPLETED restart, and the dataSync FGS 6h/24h cap on Android 15+ stops
 * the service on {@link #onTimeout(int)} (upgrade path noted there).
 */
public class NtfyForegroundService extends Service {

    private static final String TAG = "PizzapiNtfy";
    private static final String CHANNEL_ID = "pizzapi-ntfy";
    private static final int SERVICE_NOTIF_ID = 0x9_0000;
    private static final int FIRST_MESSAGE_NOTIF_ID = 0x9_0001;
    private static final int SUMMARY_NOTIF_ID = 0x8_FFFF;
    private static final String GROUP_SESSIONS = "dev.pizzapi.SESSIONS";
    /** Matches the session id in the ntfy Click deep link (…/#/sessions/<id>). */
    private static final Pattern SESSION_ID_PATTERN = Pattern.compile("/sessions/([A-Za-z0-9_-]+)");

    static final String EXTRA_NTFY_URL = "ntfyUrl";
    static final String EXTRA_TOPIC = "topic";
    static final String EXTRA_TOKEN = "token";

    private static final String PREFS = "pizzapi_ntfy";
    private static final String KEY_NTFY_URL = "ntfyUrl";
    private static final String KEY_TOPIC = "topic";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_LAST_ID = "lastId";
    private static final String KEY_FIRST_START = "firstStart";

    private static final int INITIAL_BACKOFF_MS = 1000;
    private static final int MAX_BACKOFF_MS = 30_000;
    private static final int READ_TIMEOUT_MS = 60_000; // slightly above ntfy's ~45s keepalive
    private static final int SEEN_CACHE_MAX = 200;

    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicInteger messageNotifSeq = new AtomicInteger(FIRST_MESSAGE_NOTIF_ID);
    private final AtomicInteger backoff = new AtomicInteger(INITIAL_BACKOFF_MS);
    private final AtomicInteger generation = new AtomicInteger(0);

    // Guards streamThread/currentConnection so start/stop can't interleave (#8).
    private final Object lock = new Object();
    private HttpURLConnection currentConnection;
    private Thread streamThread;

    // In-memory LRU of processed ntfy message ids (dedup, #1).
    private final LinkedHashSet<String> seenIds = new LinkedHashSet<>();

    private final Handler reconnectHandler = new Handler(Looper.getMainLooper());

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String ntfyUrl;
        String topic;
        String token;
        if (intent != null
                && intent.getStringExtra(EXTRA_NTFY_URL) != null
                && intent.getStringExtra(EXTRA_TOPIC) != null) {
            ntfyUrl = intent.getStringExtra(EXTRA_NTFY_URL);
            topic = intent.getStringExtra(EXTRA_TOPIC);
            token = intent.getStringExtra(EXTRA_TOKEN);
            persistConfig(ntfyUrl, topic, token);
        } else {
            // Null-intent / missing-extras restart: reload persisted config (#5).
            SharedPreferences prefs = getPrefs();
            ntfyUrl = prefs.getString(KEY_NTFY_URL, null);
            topic = prefs.getString(KEY_TOPIC, null);
            token = prefs.getString(KEY_TOKEN, null);
        }

        // Always enter foreground promptly, even on the stop path, to avoid
        // RemoteServiceException on system-initiated restarts (#6).
        startForeground(SERVICE_NOTIF_ID, buildServiceNotification("PizzaPi — connecting…"));

        if (ntfyUrl == null || topic == null || !isValidNtfyUrl(ntfyUrl)) {
            Log.e(TAG, "no valid ntfy config (url=" + ntfyUrl + "); stopping");
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && !nm.areNotificationsEnabled()) {
            Log.w(TAG, "POST_NOTIFICATIONS not granted; notifications will be dropped (#12)");
        }

        running.set(true);
        startStream(ntfyUrl, topic, token);
        // Redeliver the last intent (with extras) after a kill so we reconnect (#5).
        return START_REDELIVER_INTENT;
    }

    /** Validate scheme: https always ok; http only for localhost/loopback (#11). */
    private static boolean isValidNtfyUrl(String urlStr) {
        try {
            URI u = URI.create(urlStr.trim());
            String scheme = u.getScheme();
            String host = u.getHost();
            if (scheme == null || host == null) return false;
            scheme = scheme.toLowerCase(Locale.ROOT);
            if (scheme.equals("https")) return true;
            if (scheme.equals("http")) {
                host = host.toLowerCase(Locale.ROOT);
                return host.equals("localhost") || host.equals("127.0.0.1")
                        || host.equals("::1") || host.equals("10.0.2.2"); // emulator loopback
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    private void startStream(String ntfyUrl, String topic, String token) {
        synchronized (lock) {
            stopStreamLocked();
            final int gen = generation.incrementAndGet();
            streamThread = new Thread(() -> streamLoop(ntfyUrl, topic, token, gen), "pizzapi-ntfy-stream");
            streamThread.setDaemon(true);
            streamThread.start();
        }
    }

    private void streamLoop(String ntfyUrl, String topic, String token, int gen) {
        HttpURLConnection conn = null;
        try {
            SharedPreferences prefs = getPrefs();
            String lastId = prefs.getString(KEY_LAST_ID, null);
            String since;
            if (lastId != null && !lastId.isEmpty()) {
                since = lastId;
            } else {
                long firstStart = prefs.getLong(KEY_FIRST_START, 0L);
                if (firstStart == 0L) {
                    firstStart = System.currentTimeMillis() / 1000L;
                    prefs.edit().putLong(KEY_FIRST_START, firstStart).apply();
                }
                since = String.valueOf(firstStart); // bound first-connect replay to install time
            }
            String urlStr = ntfyUrl.replaceAll("/+$", "") + "/" + topic + "/json?since=" + since;
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(READ_TIMEOUT_MS); // finite: detect half-dead sockets (#2)
            conn.setRequestProperty("Accept", "application/json");
            if (token != null && !token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
            synchronized (lock) {
                currentConnection = conn;
            }

            int code = conn.getResponseCode(); // triggers the actual connect (#3/#4)
            if (code < 200 || code >= 300) {
                drainAndClose(conn.getErrorStream()); // recycle the socket (#14)
                if (isPermanent(code)) {
                    Log.e(TAG, "ntfy permanent error " + code + "; stopping (check url/topic/token)");
                    surfacePermanentError(code);
                    return;
                }
                Log.w(TAG, "ntfy transient error " + code + "; backing off");
                maybeReconnect(ntfyUrl, topic, token, gen);
                return;
            }

            updateServiceNotification("PizzaPi — connected");
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), "UTF-8"))) { // try-with-resources (#15)
                String line;
                boolean firstLine = true;
                while (running.get() && (line = reader.readLine()) != null) {
                    if (firstLine) {
                        backoff.set(INITIAL_BACKOFF_MS); // reset only on a confirmed live stream (#3)
                        firstLine = false;
                    }
                    handleMessage(line);
                }
            }
            // EOF or stopped.
            if (running.get()) {
                Log.i(TAG, "ntfy stream ended; reconnecting");
                maybeReconnect(ntfyUrl, topic, token, gen);
            }
        } catch (SocketTimeoutException e) {
            // No keepalive within the read timeout → stalled connection (#2).
            Log.w(TAG, "ntfy stream stalled (read timeout); reconnecting");
            maybeReconnect(ntfyUrl, topic, token, gen);
        } catch (Exception e) {
            Log.w(TAG, "ntfy stream error: " + e.getMessage() + "; reconnecting after backoff");
            maybeReconnect(ntfyUrl, topic, token, gen);
        } finally {
            synchronized (lock) {
                if (conn != null) {
                    try { conn.disconnect(); } catch (Exception ignored) {}
                }
                if (currentConnection == conn) {
                    currentConnection = null;
                }
            }
        }
    }

    /** 4xx are permanent except 408 (timeout) and 429 (rate limit) (#4). */
    private static boolean isPermanent(int code) {
        return code >= 400 && code < 500 && code != 408 && code != 429;
    }

    private static void drainAndClose(InputStream in) {
        if (in == null) return;
        try (InputStream s = in) {
            byte[] buf = new byte[4096];
            while (s.read(buf) != -1) { /* drain so keep-alive can recycle */ }
        } catch (Exception ignored) {}
    }

    /** Stop retrying on a permanent error, but leave a dismissible error notice. */
    private void surfacePermanentError(int code) {
        running.set(false);
        // ponytail: no auto re-auth/reconfig — user must fix the config and restart.
        reconnectHandler.post(() -> {
            updateServiceNotification("PizzaPi — push disabled (error " + code + ")");
            stopForeground(STOP_FOREGROUND_DETACH); // keep the notice visible after we stop
            stopSelf();
        });
    }

    /** Schedule a reconnect only if this thread is still the current generation (#8/#16). */
    private void maybeReconnect(String ntfyUrl, String topic, String token, int gen) {
        if (!running.get() || gen != generation.get()) return;
        updateServiceNotification("PizzaPi — reconnecting…");
        int base = backoff.getAndUpdate(b -> Math.min(b * 2, MAX_BACKOFF_MS));
        // ±30% jitter to avoid thundering-herd reconnect (#10).
        long delay = (long) (base * (1.0 + (Math.random() * 0.6 - 0.3)));
        reconnectHandler.postDelayed(() -> {
            if (running.get()) startStream(ntfyUrl, topic, token);
        }, delay);
    }

    private void handleMessage(String line) {
        if (line == null || line.isEmpty()) return;
        try {
            JSONObject obj = new JSONObject(line);
            String event = obj.optString("event", "");
            if (!"message".equals(event)) return; // ignore open/keepalive/poll_request
            String id = obj.optString("id", "");
            if (!id.isEmpty()) {
                synchronized (seenIds) {
                    if (!seenIds.add(id)) return; // already processed → drop duplicate (#1)
                    while (seenIds.size() > SEEN_CACHE_MAX) {
                        Iterator<String> it = seenIds.iterator();
                        it.next();
                        it.remove(); // evict oldest
                    }
                }
                getPrefs().edit().putString(KEY_LAST_ID, id).apply(); // advance cursor (#1)
            }
            String title = obj.optString("title", "PizzaPi");
            String body = obj.optString("message", "");
            String clickUrl = obj.optString("click", "");
            String sessionId = sessionIdFromClickUrl(clickUrl);
            if (sessionId != null) {
                postSessionNotification(sessionId, title, body, clickUrl);
            } else {
                postMessageNotification(title, body, clickUrl);
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to parse ntfy line: " + e.getMessage());
        }
    }

    /** Pull the session id out of the click deep link, or null if absent. */
    static String sessionIdFromClickUrl(String clickUrl) {
        if (clickUrl == null || clickUrl.isEmpty()) return null;
        Matcher m = SESSION_ID_PATTERN.matcher(clickUrl);
        return m.find() ? m.group(1) : null;
    }

    /**
     * Conversation-style notification: one notification per session, replies
     * append as chat messages (MessagingStyle keeps the last 25). Sessions
     * bundle under a single group. Existing history is recovered from the
     * currently-posted notification, so it survives service restarts as long
     * as the notification is still in the shade.
     */
    private void postSessionNotification(String sessionId, String title, String body, String clickUrl) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (!nm.areNotificationsEnabled()) {
            Log.w(TAG, "notifications disabled; dropping message (#12)");
            return;
        }

        // ponytail: hashCode collisions across sessions are theoretically
        // possible; worst case two sessions share a conversation. Fine.
        int id = ("pizzapi-session-" + sessionId).hashCode();

        // Recover the existing conversation from the posted notification.
        NotificationCompat.MessagingStyle style = null;
        try {
            for (StatusBarNotification sbn : nm.getActiveNotifications()) {
                if (sbn.getId() == id) {
                    style = NotificationCompat.MessagingStyle
                            .extractMessagingStyleFromNotification(sbn.getNotification());
                    break;
                }
            }
        } catch (Exception ignored) {}
        if (style == null) {
            style = new NotificationCompat.MessagingStyle(
                    new Person.Builder().setName("You").build());
        }

        // The agent is the sender; the session name (ntfy title) is its name.
        Person agent = new Person.Builder().setName(title).setBot(true).build();
        style.addMessage(new NotificationCompat.MessagingStyle.Message(
                body, System.currentTimeMillis(), agent));

        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setStyle(style)
                .setContentIntent(buildTapIntent(clickUrl, id))
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setGroup(GROUP_SESSIONS)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build();
        nm.notify(id, n);

        // Group summary is required for bundling on Android 7+.
        Notification summary = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle("PizzaPi")
                .setContentText("Session updates")
                .setGroup(GROUP_SESSIONS)
                .setGroupSummary(true)
                .setAutoCancel(true)
                .setContentIntent(buildTapIntent(null, SUMMARY_NOTIF_ID))
                .build();
        nm.notify(SUMMARY_NOTIF_ID, summary);
    }

    private void postMessageNotification(String title, String body, String clickUrl) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (!nm.areNotificationsEnabled()) {
            Log.w(TAG, "notifications disabled; dropping message (#12)");
            return;
        }

        int id = messageNotifSeq.getAndIncrement();
        PendingIntent contentIntent = buildTapIntent(clickUrl, id);

        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build();
        nm.notify(id, n);
    }

    /** Build the tap intent: open a valid http/https click URL, else bring the app forward. */
    private PendingIntent buildTapIntent(String clickUrl, int notifId) {
        Intent intent = null;
        if (clickUrl != null && !clickUrl.isEmpty()) {
            Uri uri = Uri.parse(clickUrl);
            String scheme = uri.getScheme();
            if (scheme != null) {
                scheme = scheme.toLowerCase(Locale.ROOT);
                if (scheme.equals("http") || scheme.equals("https")) { // exact scheme check (#17)
                    Intent view = new Intent(Intent.ACTION_VIEW, uri)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    // Only route to the browser if something can handle it (#19).
                    if (view.resolveActivity(getPackageManager()) != null) {
                        intent = view;
                    }
                }
            }
        }
        if (intent == null) {
            intent = new Intent(this, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(this, notifId, intent, flags);
    }

    private void updateServiceNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(SERVICE_NOTIF_ID, buildServiceNotification(text));
        }
    }

    private Notification buildServiceNotification(String text) {
        // Tapping the persistent service notification brings the app forward.
        Intent intent = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(this, 0, intent, flags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("PizzaPi")
                .setContentText(text)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(pi)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "PizzaPi notifications", NotificationManager.IMPORTANCE_DEFAULT);
                ch.setDescription("Agent activity and alerts from your PizzaPi sessions");
                nm.createNotificationChannel(ch);
            }
        }
    }

    private SharedPreferences getPrefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void persistConfig(String ntfyUrl, String topic, String token) {
        getPrefs().edit()
                .putString(KEY_NTFY_URL, ntfyUrl)
                .putString(KEY_TOPIC, topic)
                .putString(KEY_TOKEN, token) // null clears the key
                .apply();
    }

    private void stopStream() {
        synchronized (lock) {
            stopStreamLocked();
        }
        reconnectHandler.removeCallbacksAndMessages(null);
    }

    /** Must hold {@link #lock}. Interrupt + disconnect reliably unblocks readLine (#8). */
    private void stopStreamLocked() {
        if (streamThread != null) {
            streamThread.interrupt();
            streamThread = null;
        }
        if (currentConnection != null) {
            try { currentConnection.disconnect(); } catch (Exception ignored) {}
            currentConnection = null;
        }
    }

    /**
     * Android 15+ enforces a ~6h/24h runtime cap on dataSync foreground services.
     * The platform calls this and expects us to stop; not stopping crashes (#7).
     */
    @Override
    public void onTimeout(int startId) {
        Log.w(TAG, "FGS dataSync timeout reached; stopping cleanly");
        // ponytail: we just stop on the cap. Upgrade path: reschedule via
        // WorkManager/AlarmManager (or a data-carrying push transport) to resume
        // after the 24h window resets.
        running.set(false);
        stopStream();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        onTimeout(startId);
    }

    @Override
    public void onDestroy() {
        running.set(false);
        stopStream();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // not a bound service
    }

    /** Convenience to start the service with config. */
    public static void start(Context context, String ntfyUrl, String topic, String token) {
        Intent intent = new Intent(context, NtfyForegroundService.class)
                .putExtra(EXTRA_NTFY_URL, ntfyUrl)
                .putExtra(EXTRA_TOPIC, topic)
                .putExtra(EXTRA_TOKEN, token);
        ContextCompat.startForegroundService(context, intent);
    }

    /** Convenience to stop the service. */
    public static void stop(Context context) {
        context.stopService(new Intent(context, NtfyForegroundService.class));
    }
}
