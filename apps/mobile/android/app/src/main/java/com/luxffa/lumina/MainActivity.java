package com.luxffa.lumina;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.annotation.RequiresApi;
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

        // Notification channels, created before anything can post to one.
        //
        // The channel is what carries the sound on Android 8 and later — an FCM payload cannot
        // override it, which is exactly why web push can only ever play the system tone. Two
        // channels rather than one because they are the two things worth telling apart without
        // looking: an ordinary message, and being addressed directly.
        //
        // The ids must match CHANNEL_MESSAGES / CHANNEL_MENTIONS in backend src/lib/fcm.ts. A
        // payload naming a channel that does not exist here is dropped silently on API 26+.
        //
        // A channel's sound CANNOT be changed once it exists on a device. Android keeps whatever
        // was registered first and ignores the update, on the principle that the settings belong to
        // the user rather than the app. So changing either tone later means a NEW channel id, not
        // an edit here — and deleting the old one, or it lingers in the system settings screen.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                createNotificationChannel(
                    manager,
                    "lumina_messages",
                    "Messages",
                    "Messages in your spaces and conversations.",
                    "notify_message",
                    NotificationManager.IMPORTANCE_DEFAULT
                );
                createNotificationChannel(
                    manager,
                    "lumina_mentions",
                    "Mentions and direct messages",
                    "When someone mentions you or messages you directly.",
                    "notify_mention",
                    NotificationManager.IMPORTANCE_HIGH
                );
            }
        }

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

    /**
     * One channel, with the app's own sound attached.
     *
     * The sound is a hand-built resource URI because a channel takes a Uri, not a resource id. It
     * also needs USAGE_NOTIFICATION audio attributes: without them the tone plays on the media
     * stream, which means it ignores the notification volume and can talk over whatever is playing.
     *
     * Calling this for an id that already exists is safe and cheap — Android updates only the name
     * and description and keeps every choice the user has made since. That is the same rule that
     * makes the sound permanent; see the caller.
     */
    @RequiresApi(Build.VERSION_CODES.O)
    private void createNotificationChannel(
        NotificationManager manager,
        String id,
        String name,
        String description,
        String soundResource,
        int importance
    ) {
        NotificationChannel channel = new NotificationChannel(id, name, importance);
        channel.setDescription(description);
        channel.enableVibration(true);
        channel.setShowBadge(true);
        channel.setSound(
            Uri.parse("android.resource://" + getPackageName() + "/raw/" + soundResource),
            new AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .build()
        );
        manager.createNotificationChannel(channel);
    }
}
