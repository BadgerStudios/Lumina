import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The owner console as its own Android app.
 *
 * A distinct appId from com.luxffa.lumina on purpose: it installs alongside the normal app rather
 * than replacing it, keeps its own storage (so signing out of one doesn't touch the other), and
 * means the main app's bundle never grows to carry admin code.
 *
 * webDir points at the separate `dist-owner` build (see apps/frontend/vite.config.ts APP_VARIANT) —
 * this APK contains only the owner console, not the chat app.
 *
 * Security note: shipping an "owner app" grants nothing by itself. Everything it does goes through
 * /api/owner, which enforces requireOwner server-side on every route, so the APK on a stranger's
 * phone is an inert login screen.
 */
const config: CapacitorConfig = {
  appId: 'com.luxffa.lumina.owner',
  appName: 'Lumina Owner',
  webDir: '../frontend/dist-owner',
};

export default config;
