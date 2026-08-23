package com.luxffa.lumina;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins aren't auto-discovered the way installed Capacitor packages are, so
        // this registration is what makes AppUpdater reachable from the web layer at all. It must
        // run before super.onCreate(), which is where the bridge is built.
        registerPlugin(AppUpdaterPlugin.class);
        registerPlugin(BiometricLockPlugin.class);
        registerPlugin(AgeSignalsPlugin.class);
        super.onCreate(savedInstanceState);

        // Publish the device's system-bar insets (status bar at top, gesture/navigation bar at
        // bottom) to the web layer as CSS variables. On Android 15+ (targetSdk 35+) edge-to-edge is
        // FORCED — the WebView draws UNDER the status and navigation bars — and Android's
        // `env(safe-area-inset-*)` is unreliable there (often 0 for the status bar), so full-screen
        // web UI spills under those bars. Reading the insets ON THE WEBVIEW is self-correcting: it
        // reports 0 when the system already inset the WebView (older Android, not edge-to-edge) and
        // the real bar height when it's edge-to-edge — so this can never double-pad. The web side
        // uses `max(env(safe-area-inset-*), var(--android-safe-*, 0px))`, so iOS/web keep using env()
        // and Android gets these real values.
        final WebView webView = getBridge().getWebView();
        final float density = getResources().getDisplayMetrics().density;
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            final int top = Math.round(bars.top / density);
            final int bottom = Math.round(bars.bottom / density);
            final int left = Math.round(bars.left / density);
            final int right = Math.round(bars.right / density);
            final String js =
                "document.documentElement.style.setProperty('--android-safe-top','" + top + "px');"
                + "document.documentElement.style.setProperty('--android-safe-bottom','" + bottom + "px');"
                + "document.documentElement.style.setProperty('--android-safe-left','" + left + "px');"
                + "document.documentElement.style.setProperty('--android-safe-right','" + right + "px');";
            webView.post(() -> webView.evaluateJavascript(js, null));
            // Not consumed — return the insets so the WebView still lays out edge-to-edge.
            return insets;
        });
        ViewCompat.requestApplyInsets(webView);
    }
}
