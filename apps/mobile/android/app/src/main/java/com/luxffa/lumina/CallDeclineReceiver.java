package com.luxffa.lumina;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The Decline button on a ringing call: stops this phone ringing.
 *
 * It does not reach the server — a broadcast from a notification has no signed-in session to speak
 * with — so the caller's ring runs out on its own a minute later, the same as an unanswered call.
 * Declining from inside the app still tells the caller at once.
 */
public class CallDeclineReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        CallRinger.cancel(ctx, intent.getStringExtra(CallRinger.EXTRA_CONVERSATION));
    }
}
