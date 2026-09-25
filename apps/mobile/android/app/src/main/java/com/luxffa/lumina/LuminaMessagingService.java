package com.luxffa.lumina;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * Lumina's receiver for every FCM message, standing in for the push plugin's own.
 *
 * Everything that is not a call goes straight to the plugin, unchanged: messages, mentions and
 * channel posts are drawn by Android from the notification the server sends, exactly as before.
 *
 * Calls are the exception. The server sends them as data-only messages — "call" to ring and
 * "call-cancel" to stop — because a data-only message reaches this method even when the app is not
 * running, and only code on the phone can build a notification that rings and wakes the screen
 * (see CallRinger). The manifest removes the plugin's service and declares this one, so there is
 * exactly one receiver for com.google.firebase.MESSAGING_EVENT.
 */
public class LuminaMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        String type = data.get("type");
        if ("call".equals(type)) {
            CallRinger.ring(this, data.get(CallRinger.EXTRA_CONVERSATION), data.get("callerName"));
            return;
        }
        if ("call-cancel".equals(type)) {
            CallRinger.cancel(this, data.get(CallRinger.EXTRA_CONVERSATION));
            return;
        }
        super.onMessageReceived(message);
    }
}
