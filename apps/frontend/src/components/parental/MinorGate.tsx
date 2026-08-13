import { useEffect, useState } from "react";
import { ShieldAlert, Copy, Check, Flag, Eye } from "lucide-react";
import { useMinorState, useEnsurePairingCode } from "../../queries/parental";
import { useAuthStore } from "../../store/authStore";

const PROMPT_SESSION_KEY = "lumina-minor-safety-ack";

/**
 * Everything a minor account sees that an adult does not.
 *
 * Three distinct things live here because they share one piece of state (`useMinorState`) and all
 * three are wrong to render for an adult:
 *
 *  1. **The lock screen** — a minor with no responsible adult yet. Covers the app entirely.
 *  2. **The safety prompt** — shown once per session, every session, on the operator's instruction
 *     that it appear on *every* login.
 *  3. **The supervision notice** — a permanent, unmissable line saying a parent can see this
 *     account. Non-negotiable in my view: covert monitoring of a teenager by an app that never
 *     told them is a different product from parental controls, and every youth-privacy regime that
 *     addresses this at all requires the young person be told.
 */
export function MinorGate({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const { data: state } = useMinorState();

  if (!user || !state?.isMinor) return <>{children}</>;
  if (state.locked) return <PairingLock />;

  return (
    <>
      <SupervisionNotice parentName={state.parent?.displayName ?? state.parent?.username ?? null} />
      <SafetyPrompt />
      {children}
    </>
  );
}

/** Full-screen. A locked account can do nothing, so offering it a partial UI would only invite
 * clicking things that all return the same refusal. */
function PairingLock() {
  const { data: state } = useMinorState();
  const ensureCode = useEnsurePairingCode();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!state?.pairingCode) ensureCode.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.pairingCode]);

  const code = state?.pairingCode ?? null;

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-base-900 p-6">
      <div className="w-full max-w-md rounded-2xl bg-base-800 p-6 ring-1 ring-base-600">
        <ShieldAlert className="mb-3 text-accent" size={28} />
        <h1 className="text-xl font-semibold text-signal">One more step</h1>
        <p className="mt-2 text-sm text-signal-dim">
          Because you're under 18, a parent or guardian needs to connect their Lumina account to yours
          before you can start using Lumina.
        </p>

        <div className="mt-5 rounded-xl bg-base-900 p-4">
          <p className="text-xs font-bold uppercase text-signal-dim">Your pairing code</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 select-all font-mono text-2xl tracking-widest text-signal">
              {code ?? "………"}
            </code>
            {code && (
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(code);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="rounded p-2 text-signal-dim hover:bg-base-700 hover:text-signal"
                title="Copy code"
              >
                {copied ? <Check size={16} className="text-online" /> : <Copy size={16} />}
              </button>
            )}
          </div>
        </div>

        <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm text-signal-dim">
          <li>Ask your parent or guardian to sign in to their own Lumina account.</li>
          <li>They open Settings → Family and enter this code.</li>
          <li>Come back here and refresh.</li>
        </ol>

        <p className="mt-4 text-xs text-signal-faint">
          They'll be able to see your messages, who you talk to and the servers you join. Nobody can see
          your account until then.
        </p>
      </div>
    </div>
  );
}

/** Always visible, never dismissible. The child is entitled to know this is on. */
function SupervisionNotice({ parentName }: { parentName: string | null }) {
  return (
    <div className="flex shrink-0 items-center justify-center gap-2 bg-accent/15 px-3 py-1 text-center text-[11px] text-signal">
      <Eye size={12} className="shrink-0" />
      <span>
        {parentName ? `${parentName} can see this account` : "A parent or guardian can see this account"} — messages,
        contacts and servers.
      </span>
    </div>
  );
}

/**
 * Shown once per browser session, so it reappears on every fresh login exactly as asked, without
 * blocking the app on every route change within one session.
 *
 * `sessionStorage`, not `localStorage`: a localStorage flag would suppress it forever after the
 * first login, which is precisely what "always!" rules out.
 */
function SafetyPrompt() {
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.sessionStorage.getItem(PROMPT_SESSION_KEY) !== "1";
  });
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6">
      <div className="w-full max-w-md rounded-2xl bg-base-800 p-6 ring-1 ring-base-600">
        <Flag className="mb-3 text-dnd" size={26} />
        <h2 className="text-lg font-semibold text-signal">If an adult contacts you, report it</h2>
        <p className="mt-2 text-sm text-signal-dim">
          Adults aren't able to find or message accounts under 18 on Lumina. If someone over 18 does reach
          you — here, or by asking you to move to another app — report them straight away. You will never
          get in trouble for reporting someone.
        </p>
        <p className="mt-3 text-sm text-signal-dim">
          Use the <span className="font-semibold text-signal">Report</span> option on their profile or any
          message. Your parent or guardian can see your account and can help.
        </p>
        <button
          onClick={() => {
            window.sessionStorage.setItem(PROMPT_SESSION_KEY, "1");
            setOpen(false);
          }}
          className="mt-5 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover"
        >
          I understand
        </button>
      </div>
    </div>
  );
}
