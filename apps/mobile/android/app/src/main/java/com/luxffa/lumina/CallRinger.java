package com.luxffa.lumina;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;

/**
 * An incoming call while Lumina is not on screen: a ringing, full-screen notification.
 *
 * ## Why this is not an ordinary push
 *
 * A call used to arrive the way a DM does — one heads-up notification with the DM tone, gone from
 * the lock screen in seconds, easy to miss entirely. A call needs to behave like a phone call: ring
 * until it is answered, declined or given up on, and light the screen over the lock screen.
 *
 * Android only lets an app build that itself, so the server sends rings as data-only messages
 * (backend lib/fcm.ts) and LuminaMessagingService hands them here even when the app is not running.
 * A data-only message is also what lets the server take the ring back when the caller hangs up or
 * the call is answered on another device.
 *
 * ## What each part is for
 *
 * - Its own channel, "Incoming calls", with the phone's ringtone at ringtone volume. A channel's
 *   sound is fixed when it is created, so this one never shares with the message tones.
 * - FLAG_INSISTENT repeats that sound until the notification goes away: that is the ringing.
 * - A full-screen intent wakes the screen over the lock screen. Where the system has withheld that
 *   (Android 14 lets a person switch it off per app), the notification still shows and rings.
 * - Answer and the tap open the conversation through the same App Link a shared link would use,
 *   so DeepLinkHandler routes it and nothing native has to know the app's routes.
 * - Decline only silences this phone. The caller is told when they give up or when the call is
 *   declined from inside the app; a declined ring here times out on their side after a minute.
 * - It times out on its own after 45 seconds, matching the server's one-minute ring lifetime.
 */
final class CallRinger {
    static final String CHANNEL_ID = "lumina_calls";
    static final String EXTRA_CONVERSATION = "conversationId";
    private static final long RING_TIMEOUT_MS = 45_000L;
    private static final String APP_HOST = "https://lumina.badgerstudios.net";

    private CallRinger() {}

    /** One notification per conversation, so a second ring replaces the first and a cancel finds it. */
    static int notificationId(String conversationId) {
        return 0x4C00_0000 | (conversationId.hashCode() & 0x00FF_FFFF);
    }

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Rings when someone calls you on Lumina");
        Uri ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        ch.setSound(ringtone, attrs);
        ch.enableVibration(true);
        ch.setVibrationPattern(new long[] {0, 900, 700, 900, 700, 900});
        ch.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
    }

    /** Open the conversation through the app's own App Link. */
    private static PendingIntent openConversation(Context ctx, String conversationId, int requestCode) {
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(APP_HOST + "/dm/" + Uri.encode(conversationId)));
        open.setPackage(ctx.getPackageName());
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, requestCode, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void ring(Context ctx, String conversationId, String callerName) {
        if (conversationId == null || conversationId.isEmpty()) return;
        ensureChannel(ctx);
        int id = notificationId(conversationId);
        String who = (callerName == null || callerName.isEmpty()) ? "Someone" : callerName;

        PendingIntent answer = openConversation(ctx, conversationId, id);
        Intent declineIntent = new Intent(ctx, CallDeclineReceiver.class)
            .putExtra(EXTRA_CONVERSATION, conversationId);
        PendingIntent decline = PendingIntent.getBroadcast(ctx, id + 1, declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Person caller = new Person.Builder().setName(who).setImportant(true).build();
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setColor(ctx.getResources().getColor(R.color.lumina_notify, null))
            .setContentTitle(who)
            .setContentText("Incoming call")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(true)
            .setTimeoutAfter(RING_TIMEOUT_MS)
            .setContentIntent(answer)
            .setFullScreenIntent(answer, true)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer));

        android.app.Notification n = b.build();
        n.flags |= android.app.Notification.FLAG_INSISTENT;
        try {
            NotificationManagerCompat.from(ctx).notify(id, n);
        } catch (SecurityException notAllowed) {
            // Notifications switched off for the app: there is nobody to ring.
        }
    }

    static void cancel(Context ctx, String conversationId) {
        if (conversationId == null || conversationId.isEmpty()) return;
        NotificationManagerCompat.from(ctx).cancel(notificationId(conversationId));
    }
}
