package com.luxffa.lumina;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;

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
