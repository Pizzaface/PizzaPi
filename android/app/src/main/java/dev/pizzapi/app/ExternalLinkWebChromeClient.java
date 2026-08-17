package dev.pizzapi.app;

import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.os.Message;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * Capacitor's BridgeWebChromeClient never overrides onCreateWindow, so
 * target="_blank" anchors and window.open() calls (including from inside
 * sandboxed artifact/service-panel iframes, once they carry allow-popups)
 * are silently dropped by Android's WebView -- nothing happens. This
 * subclass implements it: a throwaway WebView is handed to the caller as
 * the new-window "transport"; the first URL it tries to load is routed
 * through the bridge's normal external-URL handling (system browser
 * Intent via Bridge#launchIntent), then the fake window is discarded.
 */
public class ExternalLinkWebChromeClient extends BridgeWebChromeClient {
    private final Bridge bridge;

    public ExternalLinkWebChromeClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
        WebView transport = new WebView(view.getContext());
        transport.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                bridge.launchIntent(request.getUrl());
                return true;
            }
        });
        ((WebView.WebViewTransport) resultMsg.obj).setWebView(transport);
        resultMsg.sendToTarget();
        return true;
    }
}
