package com.luxffa.lumina;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import java.util.List;

import androidx.core.content.ContextCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Starts and stops VoiceCallService for the web layer (frontend lib/nativeVoiceCall.ts).
 *
 * Called once a join succeeds, which is always right after a tap, so the app is in the foreground
 * — the only moment Android lets a microphone foreground service start.
 */
@CapacitorPlugin(name = "VoiceCall")
public class VoiceCallPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        Context context = getContext();
        // Android 14+ refuses a microphone foreground service without the permission, and it would
        // refuse from inside the service where the failure is harder to report. A stage listener who
        // never granted the microphone simply goes without; the call works while the app is open.
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            call.reject("microphone permission not granted");
            return;
        }
        Intent intent = new Intent(context, VoiceCallService.class)
                .putExtra(VoiceCallService.EXTRA_TITLE, call.getString("title", "In a voice call"))
                .putExtra(VoiceCallService.EXTRA_TEXT, call.getString("text", "Tap to return to Lumina"));
        try {
            ContextCompat.startForegroundService(context, intent);
            call.resolve();
        } catch (RuntimeException e) {
            // ForegroundServiceStartNotAllowedException: the app went to the background first.
            call.reject("could not start the call service: " + e.getMessage());
        }
    }

    /** Whether incoming calls may take over a locked screen (always true before Android 14). */
    @PluginMethod
    public void fullScreenStatus(PluginCall call) {
        boolean granted = true;
        if (Build.VERSION.SDK_INT >= 34) {
            NotificationManager nm = getContext().getSystemService(NotificationManager.class);
            granted = nm == null || nm.canUseFullScreenIntent();
        }
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    /** Opens the one system switch that lets calls use the full screen (the app's notification settings before 14). */
    @PluginMethod
    public void openFullScreenSettings(PluginCall call) {
        Context context = getContext();
        Intent intent = Build.VERSION.SDK_INT >= 34
            ? new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + context.getPackageName()))
            : new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
        } catch (RuntimeException e) {
            context.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    @Override
    public void load() {
        stopRingingFor(getActivity() != null ? getActivity().getIntent() : null);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        stopRingingFor(intent);
    }

    /** Opened from a ringing call (CallRinger): the person has seen it, so the phone stops ringing. */
    private void stopRingingFor(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null) return;
        List<String> path = data.getPathSegments();
        if (path.size() == 2 && "dm".equals(path.get(0))) CallRinger.cancel(getContext(), path.get(1));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopService();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        // The activity (and its WebView, and the call) is going away.
        stopService();
    }

    private void stopService() {
        Context context = getContext();
        context.stopService(new Intent(context, VoiceCallService.class));
    }
}
