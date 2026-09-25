package com.luxffa.lumina;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * The Decline button on a ringing call: stops this phone ringing, then tells the server.
 *
 * A broadcast from a notification has no signed-in session, so the ring carried a token that can
 * decline this one call for this one person and nothing else (backend lib/callToken.ts). Posting it
 * ends the call attempt for everyone: the caller stops ringing and the conversation says the call
 * was declined. The phone goes quiet first, whatever the network does.
 */
public class CallDeclineReceiver extends BroadcastReceiver {
    static final String EXTRA_DECLINE_TOKEN = "declineToken";
    private static final String DECLINE_URL = "https://lumina.badgerstudios.net/api/voice/calls/decline";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String conversationId = intent.getStringExtra(CallRinger.EXTRA_CONVERSATION);
        CallRinger.cancel(ctx, conversationId);
        String token = intent.getStringExtra(EXTRA_DECLINE_TOKEN);
        if (conversationId == null || token == null || token.isEmpty()) return;

        PendingResult pending = goAsync();
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                JSONObject body = new JSONObject();
                body.put("conversationId", conversationId);
                body.put("token", token);
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                conn = (HttpURLConnection) new URL(DECLINE_URL).openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(bytes);
                }
                conn.getResponseCode();
            } catch (Exception ignored) {
                // Offline or the ring already ended: the caller's ring runs out on its own.
            } finally {
                if (conn != null) conn.disconnect();
                pending.finish();
            }
        }, "lumina-call-decline").start();
    }
}
