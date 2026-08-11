import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { ShieldCheck, Copy, Check, Loader2, AlertTriangle } from "lucide-react";
import { useBeginMfa, useConfirmMfa, useDisableMfa, useMfaStatus } from "../../queries/auth";
import { ApiError } from "../../lib/apiClient";

/**
 * Two-factor enrolment.
 *
 * ## The QR code is rendered here, in the browser
 *
 * The obvious shortcut is an `<img>` pointing at one of the many public QR-generation URLs. That
 * would put the TOTP secret in a third party's request logs — the entire second factor, handed to
 * someone else, for a picture. The `qrcode` package draws it locally from the same string.
 *
 * ## Backup codes are shown once and gated behind an acknowledgement
 *
 * They are hashed server-side the moment they are created, so this render is genuinely the only
 * time they exist in readable form. A user who closes the dialog without copying them has an
 * account that a lost phone makes permanently inaccessible — hence the explicit confirm step rather
 * than a dismissable panel.
 */
export function MfaSetup() {
  const status = useMfaStatus();
  const begin = useBeginMfa();
  const confirm = useConfirmMfa();
  const disable = useDisableMfa();

  const [qrDataURL, setQrDataURL] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [password, setPassword] = useState("");
  const [showDisable, setShowDisable] = useState(false);

  useEffect(() => {
    if (!begin.data) return;
    setSecret(begin.data.secret);
    // Drawn to a data URL rather than a canvas ref so it survives re-renders without an effect
    // re-running against a node that may have been replaced.
    void QRCode.toDataURL(begin.data.otpauthURI, { width: 200, margin: 1 }).then(setQrDataURL);
  }, [begin.data]);

  if (status.isLoading) {
    return <p className="text-sm text-signal-dim">Loading…</p>;
  }

  // ---- already on -------------------------------------------------------------------------
  if (status.data?.enabled && !backupCodes) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-online">
          <ShieldCheck size={16} /> Two-factor authentication is on
        </div>
        <p className="text-xs text-signal-faint">
          {status.data.backupCodesRemaining} backup code
          {status.data.backupCodesRemaining === 1 ? "" : "s"} left.
          {status.data.backupCodesRemaining <= 2 && (
            <span className="text-flare"> Turn it off and on again to get a fresh set.</span>
          )}
        </p>

        {!showDisable ? (
          <button
            type="button"
            onClick={() => setShowDisable(true)}
            className="rounded-lg bg-base-600 px-3 py-1.5 text-xs text-signal hover:bg-base-500"
          >
            Turn off
          </button>
        ) : (
          <div className="space-y-2 rounded-lg border border-hairline bg-base-900 p-3">
            {/* The password again, on purpose: without it anyone who reaches an unlocked, already
                signed-in session can strip the second factor in two taps. */}
            <label className="block text-xs text-signal-dim">
              Confirm your password to turn it off
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded bg-base-800 px-2 py-1.5 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-accent"
              />
            </label>
            {disable.isError && (
              <p className="text-xs text-dnd">
                {disable.error instanceof ApiError ? disable.error.message : "Couldn't turn it off"}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!password || disable.isPending}
                onClick={() => disable.mutate(password, { onSuccess: () => { setShowDisable(false); setPassword(""); } })}
                className="rounded-lg bg-dnd px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                {disable.isPending ? "Turning off…" : "Turn off"}
              </button>
              <button
                type="button"
                onClick={() => { setShowDisable(false); setPassword(""); }}
                className="rounded-lg bg-base-600 px-3 py-1.5 text-xs text-signal"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---- backup codes, shown exactly once ----------------------------------------------------
  if (backupCodes) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-online">
          <ShieldCheck size={16} /> Two-factor authentication is on
        </div>
        <div className="rounded-lg border border-flare/40 bg-flare/10 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-flare">
            <AlertTriangle size={13} /> Save these now — they are not shown again
          </p>
          <p className="mt-1 text-xs text-signal-dim">
            Each works once, and gets you in if you lose your phone.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm text-signal">
            {backupCodes.map((c) => (
              <span key={c} className="select-all">{c}</span>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(backupCodes.join("\n"));
              setCopied(true);
            }}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-base-700 px-2.5 py-1 text-xs text-signal hover:bg-base-600"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy all"}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setBackupCodes(null)}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white"
        >
          I've saved them
        </button>
      </div>
    );
  }

  // ---- enrolment --------------------------------------------------------------------------
  return (
    <div className="space-y-3">
      <p className="text-xs text-signal-dim">
        Adds a second step at sign-in using an authenticator app. Strongly recommended if this
        account can moderate or manage the platform.
      </p>

      {!begin.data ? (
        <button
          type="button"
          disabled={begin.isPending}
          onClick={() => begin.mutate()}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {begin.isPending && <Loader2 size={12} className="animate-spin" />}
          Set up
        </button>
      ) : (
        <div className="space-y-3 rounded-lg border border-hairline bg-base-900 p-3">
          <p className="text-xs text-signal-dim">1. Scan this with your authenticator app</p>
          {qrDataURL && <img src={qrDataURL} alt="" className="rounded bg-white p-1" width={200} height={200} />}
          {/* The secret in text as well: a desktop password manager is often where this actually
              goes, and there is no camera to point at the screen. */}
          <p className="text-xs text-signal-faint">
            Can't scan? Enter this key: <span className="select-all font-mono text-signal">{secret}</span>
          </p>

          <label className="block text-xs text-signal-dim">
            2. Enter the 6-digit code it shows
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              className="mt-1 w-full rounded bg-base-800 px-2 py-1.5 font-mono text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-accent"
            />
          </label>

          {confirm.isError && (
            <p className="text-xs text-dnd">
              {confirm.error instanceof ApiError ? confirm.error.message : "That code didn't work"}
            </p>
          )}

          <button
            type="button"
            disabled={code.replace(/\D/g, "").length < 6 || confirm.isPending}
            onClick={() =>
              confirm.mutate(code, {
                onSuccess: (data) => {
                  setBackupCodes(data.backupCodes);
                  setCode("");
                },
              })
            }
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {confirm.isPending && <Loader2 size={12} className="animate-spin" />}
            Turn on
          </button>
        </div>
      )}
    </div>
  );
}
