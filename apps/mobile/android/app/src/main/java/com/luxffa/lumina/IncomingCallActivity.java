package com.luxffa.lumina;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.content.ContextCompat;

/**
 * The screen a call wakes on a locked phone: who is calling, Answer, Decline. Nothing else.
 *
 * A full-screen intent needs an activity that is allowed to show over the lock screen, and Lumina
 * had none: MainActivity is the whole app, and letting it show while locked would put people's
 * conversations on the lock screen. So a call lit nothing, and the phone rang in the dark. This
 * activity shows over the lock screen and turns the screen on, and it only ever shows a name.
 *
 * - Answer asks to unlock (the system's own prompt), then opens the conversation and joins the
 *   call, exactly as the notification's Answer does.
 * - Decline goes through CallDeclineReceiver, so the caller is told too.
 * - It closes itself when the ring ends anywhere else (CallRinger.cancel broadcasts ACTION_CLOSE),
 *   and after the same 45 seconds the ring itself lasts.
 */
public class IncomingCallActivity extends Activity {
    static final String ACTION_CLOSE = "com.luxffa.lumina.CLOSE_INCOMING_CALL";
    static final String EXTRA_CALLER = "callerName";
    private static final long TIMEOUT_MS = 45_000L;

    private String conversationId;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final BroadcastReceiver closer = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            String id = intent.getStringExtra(CallRinger.EXTRA_CONVERSATION);
            if (id == null || id.equals(conversationId)) finish();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        Intent in = getIntent();
        conversationId = in.getStringExtra(CallRinger.EXTRA_CONVERSATION);
        if (conversationId == null) {
            finish();
            return;
        }
        String caller = in.getStringExtra(EXTRA_CALLER);
        if (caller == null || caller.isEmpty()) caller = "Someone";
        final String declineToken = in.getStringExtra(CallDeclineReceiver.EXTRA_DECLINE_TOKEN);

        setContentView(buildView(caller, declineToken));
        ContextCompat.registerReceiver(this, closer, new IntentFilter(ACTION_CLOSE), ContextCompat.RECEIVER_NOT_EXPORTED);
        handler.postDelayed(this::finish, TIMEOUT_MS);
    }

    private LinearLayout buildView(String caller, String declineToken) {
        float dp = getResources().getDisplayMetrics().density;
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(Color.parseColor("#120F1F"));
        root.setPadding((int) (24 * dp), (int) (120 * dp), (int) (24 * dp), (int) (72 * dp));

        TextView label = new TextView(this);
        label.setText("Lumina call");
        label.setTextColor(Color.parseColor("#9C98B8"));
        label.setTextSize(15);
        label.setGravity(Gravity.CENTER);
        root.addView(label);

        TextView name = new TextView(this);
        name.setText(caller);
        name.setTextColor(Color.WHITE);
        name.setTextSize(34);
        name.setGravity(Gravity.CENTER);
        name.setPadding(0, (int) (12 * dp), 0, 0);
        root.addView(name);

        LinearLayout spacer = new LinearLayout(this);
        root.addView(spacer, new LinearLayout.LayoutParams(1, 0, 1f));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        Button decline = roundButton("Decline", "#E5484D", dp);
        Button answer = roundButton("Answer", "#30A46C", dp);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams((int) (132 * dp), (int) (64 * dp));
        lp.setMargins((int) (14 * dp), 0, (int) (14 * dp), 0);
        row.addView(decline, lp);
        row.addView(answer, new LinearLayout.LayoutParams(lp));
        root.addView(row);

        decline.setOnClickListener(v -> {
            sendBroadcast(new Intent(this, CallDeclineReceiver.class)
                .putExtra(CallRinger.EXTRA_CONVERSATION, conversationId)
                .putExtra(CallDeclineReceiver.EXTRA_DECLINE_TOKEN, declineToken));
            finish();
        });
        answer.setOnClickListener(v -> answer());
        return root;
    }

    private Button roundButton(String text, String color, float dp) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextColor(Color.WHITE);
        b.setTextSize(17);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor(color));
        bg.setCornerRadius(32 * dp);
        b.setBackground(bg);
        return b;
    }

    /** Unlock first (the system asks for the PIN if there is one), then open the call in the app. */
    private void answer() {
        CallRinger.cancel(this, conversationId);
        Runnable open = () -> {
            startActivity(CallRinger.conversationIntent(this, conversationId, true));
            finish();
        };
        KeyguardManager km = getSystemService(KeyguardManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && km != null && km.isKeyguardLocked()) {
            km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    open.run();
                }
            });
        } else {
            open.run();
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        try {
            unregisterReceiver(closer);
        } catch (IllegalArgumentException notRegistered) {
            // finished before registering (no conversation id)
        }
        super.onDestroy();
    }
}
