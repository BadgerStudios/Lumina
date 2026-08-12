package com.luxffa.lumina;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins aren't auto-discovered the way installed Capacitor packages are, so
        // this registration is what makes AppUpdater reachable from the web layer at all. It must
        // run before super.onCreate(), which is where the bridge is built.
        registerPlugin(AppUpdaterPlugin.class);
        registerPlugin(BiometricLockPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
