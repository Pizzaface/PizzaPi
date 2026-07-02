package dev.pizzapi.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the local ntfy foreground-service push plugin before the
        // bridge initializes. registerPlugin must be called before super.onCreate.
        registerPlugin(NtfyPushPlugin.class);
        super.onCreate(savedInstanceState);
    }
}