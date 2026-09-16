package com.luxffa.lumina;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * Keeps a voice call alive while Lumina is not on screen.
 *
 * The call itself is WebRTC inside the WebView; nothing here touches audio. What this service
 * changes is how Android treats the process. Without it, locking the screen or switching apps
 * makes Lumina a background app, and Android then does two things that end a call silently:
 * it hands the microphone silence (background apps may not record), and shortly after it freezes
 * the process, which stops the WebView's JavaScript and drops the socket. A foreground service of
 * type microphone, started while the app is visible, is the sanctioned way to keep both.
 *
 * The notification it shows is required by Android and doubles as the way back into the call.
 */
public class VoiceCallService extends Service {
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";

    private static final String TAG = "LuminaVoiceCall";
    private static final String CHANNEL_ID = "lumina_voice_call";
    private static final int NOTIFICATION_ID = 7311;

    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        Notification notification = buildNotification(
                title != null ? title : "In a voice call",
                text != null ? text : "Tap to return to Lumina");
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
        } catch (RuntimeException e) {
            // SecurityException when the microphone permission is gone, or the start-from-background
            // refusal on Android 12+. The call still works while the app is open; only the screen-off
            // guarantee is lost, and crashing the app over that would end the call outright.
            Log.w(TAG, "could not run the call in the foreground", e);
            stopSelf();
            return START_NOT_STICKY;
        }
        holdWakeLock();
        // Not sticky: if Android kills the process the WebView and the call are gone with it, and a
        // restarted service would only show a notification for a call that no longer exists.
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Swiping Lumina away destroys the WebView that holds the call.
        stopSelf();
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    private void holdWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm == null) return;
        // Partial: the screen may sleep, the CPU may not, or audio stutters as the device dozes.
        // Capped as a backstop in case the web layer never says the call ended.
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Lumina:voiceCall");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(6 * 60 * 60 * 1000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private Notification buildNotification(String title, String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
            // Low importance: an ongoing call should sit quietly in the shade, never ring or pop up.
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Ongoing calls", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while you are in a voice room or call");
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }
        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build();
    }
}
