package com.luxffa.lumina.owner;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * In-app APK update: download the published build, verify it, and hand it to the system installer.
 *
 * A deliberate copy of apps/mobile/.../AppUpdaterPlugin.java, not accidental drift. The two apps
 * are separate Gradle projects with separate applicationIds and no shared module between them;
 * introducing one to hold ~150 lines would mean a new library module, its own build file and a
 * Capacitor sync path through both projects. If this file needs a fix, the other one almost
 * certainly needs the same fix — they differ only in package name and the cache filename, which
 * differs so the two apps can never hand each other a half-written download.
 *
 * Lumina is distributed as a sideloaded APK rather than through Play, so there is no store to do
 * this. Before this plugin the "update" flow was a link that dropped the user into a browser
 * download, then a notification tray, then a file manager — enough steps that installed clients
 * simply stayed old, which is why a shipped fix could still look broken on someone's phone.
 *
 * What this deliberately does NOT do is install silently. Android only permits that for device
 * owner / system apps; a normal app can download the package and *launch* the installer, and the
 * user confirms. That confirmation is the platform's protection against exactly the thing this
 * code does, so working around it is not a goal — the aim is one tap instead of six.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    private static final int BUFFER_SIZE = 64 * 1024;
    /** Progress events fire at most this often. Emitting one per read chunk floods the bridge and
     * makes the download measurably slower than the network it is waiting on. */
    private static final long PROGRESS_INTERVAL_MS = 250;

    /**
     * Whether the OS will let this app launch a package installer at all. On Android 8+ the user
     * grants "install unknown apps" per-app, and an install intent fired without it fails with no
     * visible explanation — so the UI asks first rather than looking broken.
     */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject result = new JSObject();
        result.put("value", hasInstallPermission());
        call.resolve(result);
    }

    /** Opens the OS screen where that permission is granted, scoped to this app. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                    .setData(Uri.parse("package:" + getContext().getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        call.resolve();
    }

    /**
     * Downloads `url`, checks it against `sha256` if one was supplied, and opens the installer.
     *
     * The hash check is not optional security theatre: the APK is fetched over the network and
     * then handed to the system installer with this app's blessing. The digest comes from the
     * authenticated API response rather than from alongside the file, so a substituted download
     * fails the comparison instead of being installed.
     */
    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        final String url = call.getString("url");
        final String expectedSha256 = call.getString("sha256");
        if (url == null || url.isEmpty()) {
            call.reject("No download url supplied");
            return;
        }
        if (!hasInstallPermission()) {
            call.reject("PERMISSION_REQUIRED");
            return;
        }

        new Thread(() -> {
            File target = null;
            try {
                target = download(url, expectedSha256);
                launchInstaller(target);
                call.resolve();
            } catch (SecurityException e) {
                // A failed digest must not leave the rejected package sitting in the cache where a
                // later run could pick it up.
                if (target != null) {
                    //noinspection ResultOfMethodCallIgnored
                    target.delete();
                }
                call.reject("CHECKSUM_MISMATCH");
            } catch (Exception e) {
                // The class name is the diagnostic: "UnknownHostException" vs "SocketTimeoutException"
                // vs "ActivityNotFoundException" point at completely different fixes, and the web
                // layer shows this text to the user so the reason is never hidden behind a generic toast.
                call.reject(e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage()));
            }
        }).start();
    }

    private boolean hasInstallPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        PackageManager pm = getContext().getPackageManager();
        return pm != null && pm.canRequestPackageInstalls();
    }

    private File download(String url, String expectedSha256) throws Exception {
        File dir = new File(getContext().getCacheDir(), "updates");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        // One fixed filename, overwritten each time: a per-version name would accumulate ~7MB per
        // update in a directory nothing ever prunes.
        File target = new File(dir, "lumina-owner-update.apk");

        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(20_000);
        conn.setReadTimeout(60_000);
        conn.setInstanceFollowRedirects(true);
        // Explicit headers: HttpURLConnection sends a bare Dalvik/… user agent and no Accept, the
        // exact shape edge bot-filters treat as automated. Name ourselves honestly instead.
        conn.setRequestProperty("User-Agent", "Lumina-Android-Updater (" + getContext().getPackageName() + ")");
        conn.setRequestProperty("Accept", "application/vnd.android.package-archive, */*");
        conn.connect();

        int status = conn.getResponseCode();
        if (status < 200 || status >= 300) {
            conn.disconnect();
            throw new Exception("Download failed (HTTP " + status + ")");
        }

        long total = conn.getContentLengthLong();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long read = 0;
        long lastEmit = 0;

        try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[BUFFER_SIZE];
            int n;
            while ((n = in.read(buffer)) != -1) {
                out.write(buffer, 0, n);
                digest.update(buffer, 0, n);
                read += n;

                long now = System.currentTimeMillis();
                if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
                    lastEmit = now;
                    JSObject progress = new JSObject();
                    progress.put("loaded", read);
                    progress.put("total", total);
                    notifyListeners("downloadProgress", progress);
                }
            }
        } finally {
            conn.disconnect();
        }

        JSObject done = new JSObject();
        done.put("loaded", read);
        done.put("total", total > 0 ? total : read);
        notifyListeners("downloadProgress", done);

        if (expectedSha256 != null && !expectedSha256.isEmpty()) {
            String actual = toHex(digest.digest());
            if (!actual.equalsIgnoreCase(expectedSha256)) {
                throw new SecurityException("checksum mismatch");
            }
        }

        return target;
    }

    private void launchInstaller(File apk) {
        // A file:// Uri is refused outright from Android 7 on; the FileProvider already declared in
        // AndroidManifest.xml hands the installer a content:// Uri plus a one-shot read grant.
        Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                apk
        );
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format(Locale.US, "%02x", b));
        return sb.toString();
    }
}
