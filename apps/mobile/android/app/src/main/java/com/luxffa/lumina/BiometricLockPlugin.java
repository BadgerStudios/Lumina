package com.luxffa.lumina;

import android.content.Context;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.Executor;

/**
 * Biometric unlock for the packaged Android apps.
 *
 * ## Why this exists separately from passkeys
 *
 * The web app signs in with WebAuthn passkeys — Face ID, fingerprint, Windows Hello. The Capacitor
 * apps cannot: WebAuthn binds a credential to the registrable domain of the page's origin, and
 * these load from `capacitor://localhost`, which can never match `lumina.badgerstudios.net`. That
 * is a property of the standard, not a bug to route around.
 *
 * So the packaged apps get the other shape of the same feature. Rather than a credential the server
 * verifies, this is a **local gate on an existing session**: the refresh token is already stored on
 * the device, and the biometric decides whether the app may use it on this launch.
 *
 * ## What that does and does not buy
 *
 * Worth being precise, because "biometric login" implies more than this delivers. It protects
 * against someone picking up an unlocked phone and opening Lumina. It does NOT protect the token
 * from someone with root or physical extraction — the token is in Capacitor Preferences, not
 * hardware-wrapped, so this is a lock on the door rather than a safe.
 *
 * Making it a safe would mean encrypting the token with a Keystore key that requires user
 * authentication to use, which is the right eventual design and a materially larger piece of work.
 * The honest description of what ships today is "convenience lock", and the UI says so.
 */
@CapacitorPlugin(name = "BiometricLock")
public class BiometricLockPlugin extends Plugin {

    /**
     * Whether this device can prompt at all.
     *
     * BIOMETRIC_WEAK is deliberately included alongside STRONG: a device-credential fallback (PIN,
     * pattern) is a perfectly reasonable lock for this purpose, and demanding STRONG would silently
     * hide the feature on hardware whose fingerprint sensor Android classifies as weak — leaving
     * the user with no explanation for why a setting everyone else has does not appear.
     */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        BiometricManager manager = BiometricManager.from(getContext());
        int status = manager.canAuthenticate(
                BiometricManager.Authenticators.BIOMETRIC_WEAK
                        | BiometricManager.Authenticators.DEVICE_CREDENTIAL);

        JSObject result = new JSObject();
        result.put("available", status == BiometricManager.BIOMETRIC_SUCCESS);
        // The reason is returned rather than swallowed: "no hardware" and "nothing enrolled" need
        // different messages, and the second is something the user can fix in Settings.
        result.put("reason", describe(status));
        call.resolve(result);
    }

    private String describe(int status) {
        switch (status) {
            case BiometricManager.BIOMETRIC_SUCCESS:
                return "available";
            case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                return "no-hardware";
            case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                return "hardware-unavailable";
            case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                return "none-enrolled";
            default:
                return "unavailable";
        }
    }

    /**
     * Prompts, and resolves with whether the user passed.
     *
     * Resolves rather than rejects on a failed or cancelled prompt: a cancel is an ordinary user
     * choice, and turning it into a rejection means every call site has to distinguish "the user
     * said no" from "something went wrong" by string-matching an error.
     */
    @PluginMethod
    public void authenticate(PluginCall call) {
        final String title = call.getString("title", "Unlock Lumina");
        final String subtitle = call.getString("subtitle", "");

        // Must run on the UI thread — BiometricPrompt attaches to the activity's fragment manager,
        // and constructing it off-thread throws.
        getActivity().runOnUiThread(() -> {
            try {
                Context context = getContext();
                Executor executor = ContextCompat.getMainExecutor(context);

                BiometricPrompt prompt = new BiometricPrompt(
                        (FragmentActivity) getActivity(),
                        executor,
                        new BiometricPrompt.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                                resolveWith(call, true, "ok");
                            }

                            @Override
                            public void onAuthenticationError(int errorCode, CharSequence errString) {
                                // Includes the user pressing Cancel, which is not an error worth
                                // reporting as one.
                                resolveWith(call, false, errString == null ? "cancelled" : errString.toString());
                            }

                            @Override
                            public void onAuthenticationFailed() {
                                // A single non-matching finger. The prompt stays open and lets them
                                // try again, so this is deliberately NOT resolved — resolving here
                                // would dismiss a prompt the OS is still showing.
                            }
                        });

                BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                        .setTitle(title)
                        .setAllowedAuthenticators(
                                BiometricManager.Authenticators.BIOMETRIC_WEAK
                                        | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
                if (!subtitle.isEmpty()) info.setSubtitle(subtitle);

                // No setNegativeButtonText: it is not permitted alongside DEVICE_CREDENTIAL, and
                // setting both throws at build time rather than being ignored.
                prompt.authenticate(info.build());
            } catch (Exception e) {
                resolveWith(call, false, e.getMessage() == null ? "error" : e.getMessage());
            }
        });
    }

    private void resolveWith(PluginCall call, boolean success, String reason) {
        JSObject result = new JSObject();
        result.put("success", success);
        result.put("reason", reason);
        call.resolve(result);
    }
}
