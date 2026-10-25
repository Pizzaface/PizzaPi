package dev.pizzapi.app;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Arrays;
import java.util.List;

/**
 * Puts Android audio in voice-call mode while Live voice is open, the way
 * call/assistant apps do, so the platform echo canceller references the
 * agent's speech and the mic doesn't hear it. Routes to the loudspeaker
 * unless a headset is connected (call mode defaults to the earpiece).
 *
 * <p>JS: {@code registerPlugin("PizzapiLiveAudio")} → {@code start()} / {@code stop()}.
 */
@CapacitorPlugin(name = "PizzapiLiveAudio")
public class LiveAudioPlugin extends Plugin {

    private static final List<Integer> HEADSETS = Arrays.asList(
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            26 /* TYPE_BLE_HEADSET, API 31 */);

    private Integer previousMode = null;

    private AudioManager audio() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    @PluginMethod
    public void start(PluginCall call) {
        AudioManager am = audio();
        if (previousMode == null) previousMode = am.getMode();
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo speaker = null;
            AudioDeviceInfo headset = null;
            for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                if (HEADSETS.contains(d.getType()) && headset == null) headset = d;
                if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) speaker = d;
            }
            AudioDeviceInfo target = headset != null ? headset : speaker;
            if (target != null) am.setCommunicationDevice(target);
        } else {
            // ponytail: pre-Android 12 only checks wired headsets; Bluetooth falls back to speaker.
            am.setSpeakerphoneOn(!am.isWiredHeadsetOn());
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        restore();
        call.resolve();
    }

    private void restore() {
        if (previousMode == null) return;
        AudioManager am = audio();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice();
        else am.setSpeakerphoneOn(false);
        am.setMode(previousMode);
        previousMode = null;
    }

    /** Never leave the phone stuck in call mode if the app goes away mid-Live. */
    @Override
    protected void handleOnDestroy() {
        restore();
    }
}
