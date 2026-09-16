package com.luxffa.lumina;

import android.net.Uri;
import android.util.Log;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * Capacitor's chrome client, minus the crash.
 *
 * Every permission prompt and file picker in BridgeWebChromeClient goes through an
 * ActivityResultLauncher registered with the activity that created it. When that activity is
 * destroyed the launcher is unregistered, and launching it throws IllegalStateException
 * ("Attempting to launch an unregistered ActivityResultLauncher"). The WebView callback runs inside
 * Chromium, which turns any Java exception into a FATAL abort of the whole app.
 *
 * That is not hypothetical: Android relaunches MainActivity on a cold start after an install or a
 * WebView update (configuration change 0x80000000, asset paths), and the destroyed activity's page
 * kept running for several seconds. A microphone request from it killed the app. MainActivity now
 * destroys that WebView outright; this class is the second layer, so a request that still reaches
 * a dead launcher is refused like any other denied permission instead of taking the app down.
 */
public class SafeWebChromeClient extends BridgeWebChromeClient {
    private static final String TAG = "LuminaChromeClient";

    public SafeWebChromeClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public void onPermissionRequest(PermissionRequest request) {
        try {
            super.onPermissionRequest(request);
        } catch (IllegalStateException e) {
            Log.w(TAG, "permission request from a page whose activity is gone; denied");
            request.deny();
        }
    }

    @Override
    public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
        try {
            super.onGeolocationPermissionsShowPrompt(origin, callback);
        } catch (IllegalStateException e) {
            Log.w(TAG, "location request from a page whose activity is gone; denied");
            callback.invoke(origin, false, false);
        }
    }

    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
        try {
            return super.onShowFileChooser(webView, filePathCallback, fileChooserParams);
        } catch (IllegalStateException e) {
            Log.w(TAG, "file picker from a page whose activity is gone; cancelled");
            filePathCallback.onReceiveValue(null);
            return true;
        }
    }
}
