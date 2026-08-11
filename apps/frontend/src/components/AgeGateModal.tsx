import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { AgeBracket, UserDTO } from "@lumina/shared";
import { api, ApiError } from "../lib/apiClient";
import { useAuthStore } from "../store/authStore";

const AGE_BRACKETS: Array<{ value: AgeBracket; label: string }> = [
  { value: "UNDER_18", label: "Under 18" },
  { value: "AGE_18_24", label: "18–24" },
  { value: "AGE_25_34", label: "25–34" },
  { value: "AGE_35_49", label: "35–49" },
  { value: "AGE_50_PLUS", label: "50+" },
];

/**
 * Blocking prompt for accounts created before age collection existed.
 *
 * Not dismissible: until the account has an age on record it is treated as a minor, which means no
 * feed and no cross-age contact — so a "later" button would just leave the person quietly restricted
 * with no explanation of why half the app doesn't work.
 *
 * Rendered above the app rather than as a route, so it appears wherever they happen to land.
 */
export function AgeGateModal() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [bracket, setBracket] = useState<AgeBracket | "">("");
  const [birthDate, setBirthDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () =>
      api.post<UserDTO>("/age", { ageBracket: bracket, birthDate }),
    onSuccess: (updated) => setUser(updated),
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again."),
  });

  // Only for signed-in accounts with nothing on record. Anyone who has answered never sees this.
  if (!user || user.ageVerified !== false) return null;

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-md rounded-xl border border-hairline bg-base-800 p-6">
        <h2 className="font-display text-xl text-signal">One quick thing</h2>
        <p className="mt-2 text-sm text-signal-dim">
          We need your age before you can carry on using Lumina. Lumina is 18+. Your date of birth is
          never shown on your profile — see our{" "}
          <a href="/privacy" className="text-accent hover:underline">
            privacy policy
          </a>
          .
        </p>

        <div className="mt-5 space-y-4">
          <div>
            <span className="text-xs font-bold uppercase text-signal-dim">Age range</span>
            <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {AGE_BRACKETS.map((b) => (
                <button
                  key={b.value}
                  type="button"
                  onClick={() => {
                    setBracket(b.value);
                    setError(null);
                  }}
                  aria-pressed={bracket === b.value}
                  className={`rounded px-2 py-2 text-sm ring-1 transition ${
                    bracket === b.value
                      ? "bg-accent text-white ring-accent"
                      : "bg-base-900 text-signal-dim ring-base-500 hover:text-signal"
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="text-xs font-bold uppercase text-signal-dim">Date of birth</span>
            <input
              type="date"
              value={birthDate}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => {
                setBirthDate(e.target.value);
                setError(null);
              }}
              className="mt-1.5 w-full rounded border-none bg-base-900 px-3 py-2.5 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
            />
          </label>

          {error && <p className="text-sm text-dnd">{error}</p>}

          <button
            type="button"
            disabled={!bracket || !birthDate || submit.isPending}
            onClick={() => {
              setError(null);
              submit.mutate();
            }}
            className="flex w-full items-center justify-center gap-2 rounded bg-accent py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {submit.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Continue
          </button>

          {/* Stated up front rather than discovered after submitting — the answer is write-once and
              people should know that before they tap. */}
          <p className="text-xs text-signal-faint">
            This is recorded once and can't be changed here. Contact support if you get it wrong.
          </p>
        </div>
      </div>
    </div>
  );
}
