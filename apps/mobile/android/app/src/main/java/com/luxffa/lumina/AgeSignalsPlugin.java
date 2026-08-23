package com.luxffa.lumina;

import android.app.Activity;
import android.content.Context;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.android.play.agesignals.AgeSignalsAccessRequest;
import com.google.android.play.agesignals.AgeSignalsManager;
import com.google.android.play.agesignals.AgeSignalsManagerFactory;
import com.google.android.play.agesignals.AgeSignalsRequest;
import com.google.android.play.agesignals.AgeSignalsResult;
import com.google.android.play.agesignals.model.AgeSignalsStatus;

import com.google.android.play.core.integrity.IntegrityManager;
import com.google.android.play.core.integrity.IntegrityManagerFactory;
import com.google.android.play.core.integrity.IntegrityTokenRequest;
import com.google.android.play.core.integrity.IntegrityTokenResponse;

import java.security.SecureRandom;

/**
 * Native age assurance for the Android app — the Google half of the layered age-verification stack.
 *
 * Two Play APIs, verified against the real 0.0.4 / 1.4.0 library classes:
 *
 *  - Play Age Signals gives a coarse age BAND (ageLower..ageUpper — never a birthdate), after the
 *    user consents to share it (requestAgeSignalsAccess). This is the age signal itself.
 *  - Play Integrity gives an attestation TOKEN proving this is the genuine, unmodified Lumina app on
 *    a genuine device. The backend (verification/attestation.ts) trusts the band ONLY if this token
 *    verifies — otherwise a repackaged app could just claim "18+".
 *
 * Everything degrades gracefully: no consent, an unsupported region (Age Signals is rolling out
 * through end of 2026), or a sideloaded build where Integrity can't attest all resolve to
 * `available:false`, and the app falls back to the self-declared birthday exactly like the web.
 *
 * The result is posted to POST /api/verification/device-signal as
 * { platform:"android", band, attestationToken } via the frontend's ageSignals.ts helper.
 */
@CapacitorPlugin(name = "AgeSignals")
public class AgeSignalsPlugin extends Plugin {

    /**
     * Returns { available, band?, ageLower?, ageUpper?, attestationToken?, reason? }.
     * Optional call param: cloudProjectNumber (Long) for Play Integrity classic requests.
     */
    @PluginMethod
    public void requestAgeSignal(final PluginCall call) {
        final Context ctx = getContext();
        final Activity activity = getActivity();
        if (ctx == null || activity == null) {
            call.resolve(unavailable("no-context"));
            return;
        }

        final Long cloudProjectNumber = call.getLong("cloudProjectNumber");

        // First fetch the attestation token; then read the band; then resolve with both. Sequential
        // rather than parallel for clarity — this runs once at signup, not on a hot path.
        fetchIntegrityToken(ctx, cloudProjectNumber, new TokenCallback() {
            @Override
            public void onToken(final String token) {
                fetchAgeBand(ctx, activity, new BandCallback() {
                    @Override
                    public void onBand(Integer lower, Integer upper) {
                        JSObject r = new JSObject();
                        if (lower == null) {
                            r.put("available", false);
                            r.put("reason", "not-shared");
                        } else {
                            r.put("available", true);
                            r.put("band", bandFrom(lower, upper));
                            r.put("ageLower", lower);
                            if (upper != null) r.put("ageUpper", upper);
                        }
                        if (token != null) r.put("attestationToken", token);
                        call.resolve(r);
                    }
                });
            }
        });
    }

    // ---- Play Integrity ----------------------------------------------------------------------

    private interface TokenCallback { void onToken(String token); }

    private void fetchIntegrityToken(Context ctx, Long cloudProjectNumber, final TokenCallback cb) {
        try {
            IntegrityManager manager = IntegrityManagerFactory.create(ctx);
            IntegrityTokenRequest.Builder b = IntegrityTokenRequest.builder().setNonce(newNonce());
            if (cloudProjectNumber != null) b.setCloudProjectNumber(cloudProjectNumber);
            manager
                .requestIntegrityToken(b.build())
                .addOnSuccessListener(new com.google.android.gms.tasks.OnSuccessListener<IntegrityTokenResponse>() {
                    @Override
                    public void onSuccess(IntegrityTokenResponse response) {
                        cb.onToken(response != null ? response.token() : null);
                    }
                })
                .addOnFailureListener(new com.google.android.gms.tasks.OnFailureListener() {
                    @Override
                    public void onFailure(Exception e) {
                        // Common on sideloaded/debug builds not recognised by Play — the band then
                        // simply isn't trusted server-side, which is the safe outcome.
                        cb.onToken(null);
                    }
                });
        } catch (Throwable t) {
            cb.onToken(null);
        }
    }

    /** URL-safe base64 nonce; Play Integrity requires a non-empty URL-safe nonce. */
    private static String newNonce() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    // ---- Play Age Signals --------------------------------------------------------------------

    private interface BandCallback { void onBand(Integer lower, Integer upper); }

    private void fetchAgeBand(Context ctx, Activity activity, final BandCallback cb) {
        try {
            final AgeSignalsManager manager = AgeSignalsManagerFactory.create(ctx);
            // Step 1: ask the user to share their age band (may show a consent UI).
            manager
                .requestAgeSignalsAccess(AgeSignalsAccessRequest.builder().setActivity(activity).build())
                .addOnSuccessListener(new com.google.android.gms.tasks.OnSuccessListener<com.google.android.play.agesignals.AgeSignalsAccessResult>() {
                    @Override
                    public void onSuccess(com.google.android.play.agesignals.AgeSignalsAccessResult access) {
                        Integer status = access != null ? access.ageSignalsStatus() : null;
                        if (status == null || status != AgeSignalsStatus.SHARED) {
                            cb.onBand(null, null); // not shared / verification required / unavailable
                            return;
                        }
                        // Step 2: read the shared band.
                        manager
                            .checkAgeSignals(AgeSignalsRequest.builder().build())
                            .addOnSuccessListener(new com.google.android.gms.tasks.OnSuccessListener<AgeSignalsResult>() {
                                @Override
                                public void onSuccess(AgeSignalsResult result) {
                                    if (result == null) { cb.onBand(null, null); return; }
                                    cb.onBand(result.ageLower(), result.ageUpper());
                                }
                            })
                            .addOnFailureListener(new com.google.android.gms.tasks.OnFailureListener() {
                                @Override public void onFailure(Exception e) { cb.onBand(null, null); }
                            });
                    }
                })
                .addOnFailureListener(new com.google.android.gms.tasks.OnFailureListener() {
                    @Override public void onFailure(Exception e) { cb.onBand(null, null); }
                });
        } catch (Throwable t) {
            cb.onBand(null, null);
        }
    }

    /** Map Play Age Signals' lower/upper bounds to the platform's band vocabulary (matches the
     * server's bandToMinorSignal: "18+", "16-17", "13-15", "0-12"). */
    private static String bandFrom(Integer lower, Integer upper) {
        int low = lower != null ? lower : 0;
        if (low >= 18) return "18+";
        if (low >= 16) return "16-17";
        if (low >= 13) return "13-15";
        return "0-12";
    }

    private static JSObject unavailable(String reason) {
        JSObject r = new JSObject();
        r.put("available", false);
        r.put("reason", reason);
        return r;
    }
}
