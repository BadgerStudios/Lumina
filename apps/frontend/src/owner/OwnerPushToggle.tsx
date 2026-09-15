import { useEffect, useState } from "react";
import { Bell, BellRing } from "lucide-react";
import {
  isNativePushSupported,
  getNativePushStatus,
  enableNativePush,
  disableNativePush,
  syncNativePushRegistration,
  type NativePushStatus,
} from "../lib/nativePush";
import { api } from "../lib/apiClient";

/**
 * Notifications for the console itself.
 *
 * The console reports on work that arrives while nobody is looking at it — a report filed at 2am,
 * a service that fell over — and until now it could only ever tell you once you had already opened
 * it. The alerts existed and were addressed to your account; what was missing was this app ever
 * asking Android for a token, so the server had nothing to send to.
 *
 * Deliberately native-only. The console also runs at /owner in the main web app, which is the same
 * origin as the chat client and therefore shares one service-worker subscription — offering a second
 * switch for the same registration there would be two controls over one thing. The packaged Android
 * console is a different app with its own token, which is what makes it a separate device worth
 * registering at all.
 *
 * Registering here does not replace the chat app: they are two devices as far as the server is
 * concerned, so a staff alert reaches both. That is the intent — the console is where you act on
 * one, and the notification that opens it should be the one you tapped.
 */
export function OwnerPushToggle() {
  const [status, setStatus] = useState<NativePushStatus | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!isNativePushSupported()) {
      setStatus("unsupported");
      return;
    }
    // FCM rotates tokens on its own schedule, and a rotated one is simply dead. This never prompts
    // and never throws — it only refreshes a registration that already exists.
    void syncNativePushRegistration();
    void getNativePushStatus().then(setStatus);
  }, []);

  async function toggle() {
    setBusy(true);
    setNote(null);
    try {
      if (status === "subscribed") {
        await disableNativePush();
        setStatus("unsubscribed");
      } else {
        await enableNativePush();
        setStatus("subscribed");
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not change notifications");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setNote(null);
    try {
      const { targeted, delivered } = await api.post<{ targeted: number; delivered: number }>("/push/test");
      const devices = (n: number) => `${n} device${n === 1 ? "" : "s"}`;
      if (targeted === 0) setNote("No devices are registered.");
      else if (delivered === 0) setNote("This registration had expired and was cleared. Turn it off and on again.");
      else if (delivered < targeted) setNote(`Sent to ${devices(delivered)}; ${devices(targeted - delivered)} had expired.`);
      else setNote(`Sent to ${devices(delivered)}.`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not send a test");
    } finally {
      setBusy(false);
    }
  }

  // Nothing to offer on the web console or a desktop build, and nothing useful to say while the
  // plugin is still being asked — an empty row that fills in a moment later is worse than no row.
  if (status === "loading" || status === "unsupported") return null;

  if (status === "denied") {
    return (
      <p className="mt-2 px-1 text-xs text-signal-faint">
        Notifications are turned off for this app in Android&rsquo;s settings.
      </p>
    );
  }

  const on = status === "subscribed";

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-xs text-signal-faint hover:text-signal disabled:opacity-50"
      >
        {on ? <BellRing className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
        {on ? "Notifications on" : "Turn on notifications"}
      </button>

      {on ? (
        <button
          type="button"
          onClick={() => void sendTest()}
          disabled={busy}
          className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 pl-[26px] text-xs text-signal-faint hover:text-signal disabled:opacity-50"
        >
          Send a test
        </button>
      ) : null}

      {note ? <p className="px-1 pt-0.5 text-[11px] leading-snug text-signal-faint">{note}</p> : null}
    </div>
  );
}
