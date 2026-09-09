import { useEffect, useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import {
  deletePasskey,
  isPasskeySupported,
  listPasskeys,
  passkeyErrorMessage,
  passkeysUsableHere,
  registerPasskey,
  type PasskeySummary,
} from "../../lib/passkeys";
import { reportError, toast } from "../../store/toastStore";

/**
 * Enrolling and managing passkeys.
 *
 * Everything here already existed — the routes, and every one of these client helpers — with no
 * screen that called them, so the passkey button on the sign-in page could never match anything.
 */
export function PasskeyPanel() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [keys, setKeys] = useState<PasskeySummary[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void isPasskeySupported().then((ok) => {
      if (!cancelled) setSupported(ok && passkeysUsableHere());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = async () => {
    try {
      setKeys(await listPasskeys());
    } catch (error) {
      reportError(error, "Couldn't load your passkeys");
    }
  };

  useEffect(() => {
    if (supported) void refresh();
  }, [supported]);

  if (supported === null) return null;
  if (!supported) {
    return (
      <p className="text-sm text-signal-faint">
        This device or browser can't use passkeys. You can still add one from a device that can.
      </p>
    );
  }

  async function add() {
    setBusy(true);
    try {
      await registerPasskey(navigator.platform || "This device");
      toast.success("Passkey added — you can sign in with it from now on");
      await refresh();
    } catch (error) {
      const message = passkeyErrorMessage(error);
      if (message) reportError(error, message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, label: string) {
    if (!confirm(`Remove the passkey "${label}"? You can add it again later.`)) return;
    try {
      await deletePasskey(id);
      toast.success("Passkey removed");
      await refresh();
    } catch (error) {
      reportError(error, "Couldn't remove that passkey");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-signal-dim">
        A passkey signs you in with the fingerprint, face or PIN you already use to unlock this
        device. Nothing to remember, and nothing to steal from a database.
      </p>

      {keys && keys.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {keys.map((key) => (
            <li
              key={key.id}
              className="flex items-center justify-between gap-3 rounded-md border border-base-600 bg-base-800 px-3 py-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <KeyRound size={15} className="shrink-0 text-signal-faint" aria-hidden="true" />
                <span className="truncate text-sm text-signal">{key.label || "Passkey"}</span>
              </span>
              <button
                type="button"
                onClick={() => void remove(key.id, key.label || "Passkey")}
                className="shrink-0 rounded p-1.5 text-signal-faint hover:bg-base-700 hover:text-dnd"
                aria-label={`Remove passkey ${key.label || ""}`}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-signal-faint">No passkeys yet.</p>
      )}

      <button
        type="button"
        onClick={() => void add()}
        disabled={busy}
        className="self-start rounded bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60"
      >
        {busy ? "Waiting for your device…" : "Add a passkey"}
      </button>
    </div>
  );
}
