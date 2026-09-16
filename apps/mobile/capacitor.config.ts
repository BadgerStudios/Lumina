import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.luxffa.lumina',
  appName: 'Lumina',
  webDir: '../frontend/dist',
  // No Capacitor logging, in any build. The APKs are debug builds, where the default ("debug")
  // mirrors every plugin call and result into the Android system log, including
  // Preferences.get -> the stored refresh token. Inspect the WebView with DevTools instead.
  loggingBehavior: 'none',
};

export default config;
