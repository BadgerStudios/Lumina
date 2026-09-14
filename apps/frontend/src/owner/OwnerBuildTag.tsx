import { useEffect, useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import { getInstalledVersion } from "../lib/appUpdater";
import { useAndroidUpdate } from "../queries/meta";
import { CLIENT_TYPE } from "../lib/platform";

/** What the web bundle was stamped with at build time (deploy.sh writes it into .env.owner). */
const BUNDLED_BUILD = Number(import.meta.env.VITE_APP_BUILD ?? 0);

/**
 * Which build of the console you are actually looking at.
 *
 * The console reports on everything except itself: it showed no version anywhere, so "am I looking
 * at current numbers, on a current build?" — the first question to ask of a dashboard — had no
 * answer on the screen. Every other surface here states its source; this one states this one.
 *
 * The number comes from the installed package rather than from the constant baked into the bundle,
 * because those two can disagree and the disagreement is exactly what matters. A Capacitor build
 * copies the web assets into the APK, so a bundle built against one version code and packaged into
 * another is silent: the app reports whatever the bundle was stamped with and looks fine. When they
 * differ, both are shown — an owner debugging "the fix I shipped isn't here" should be able to see
 * that the APK and its web assets came from different builds.
 *
 * The update marker is not a duplicate of UpdateBanner. That banner is dismissible for a day, and
 * this is the line that still says so afterwards.
 */
export function OwnerBuildTag() {
  const [installed, setInstalled] = useState<{ versionName: string | null; versionCode: number } | null>(null);
  const { available, blocked } = useAndroidUpdate();

  useEffect(() => {
    let cancelled = false;
    void getInstalledVersion().then((v) => {
      if (!cancelled) setInstalled(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Off-native (the console is also served at /owner-app/ on the web) there is no package to read,
  // and the bundle's own stamp is the honest answer rather than a missing one.
  const running = installed?.versionCode || BUNDLED_BUILD;
  if (!running) return null;

  const label = installed?.versionName ? `v${installed.versionName}` : `Build ${running}`;
  const drifted = Boolean(installed?.versionCode) && BUNDLED_BUILD > 0 && installed!.versionCode !== BUNDLED_BUILD;

  return (
    <p className="mt-2 flex items-center gap-1.5 px-1 text-[11px] text-signal-faint">
      <span className="truncate">
        {label}
        {/* Only when they disagree. In the normal case one number is the whole story. */}
        {drifted ? ` · web bundle ${BUNDLED_BUILD}` : ""}
        {CLIENT_TYPE !== "mobile" ? " · web" : ""}
      </span>
      {available && !blocked && (
        <span className="flex shrink-0 items-center gap-1 text-[var(--oc-owner)]" title="A newer build is published">
          <ArrowUpCircle className="h-3 w-3" />
          update ready
        </span>
      )}
      {blocked === "signature" && (
        <span className="shrink-0 text-amber" title="This install is signed with a different key — it needs a one-time reinstall">
          reinstall needed
        </span>
      )}
    </p>
  );
}
