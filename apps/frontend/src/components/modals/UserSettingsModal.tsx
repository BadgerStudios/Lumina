import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { COMMON_EMOJIS } from "../../lib/commonEmoji";
import { User, Palette, ShieldCheck, Code2, Mic, LogOut, X, Sun, Moon, AlignJustify, Rows3, Copy, Check, RefreshCw, Trash2, Bot, Bell, Monitor, Loader2, CreditCard, Megaphone, MailWarning } from "lucide-react";
import { MfaSetup } from "./MfaSetup";
import {
  biometricAvailability,
  isBiometricLockEnabled,
  requestBiometricUnlock,
  setBiometricLockEnabled,
} from "../../lib/biometricLock";
import { useUIStore, ACCENT_THEMES, THEMES, LIGHT_THEMES, type AccentTheme, type Theme } from "../../store/uiStore";
import { useAuthStore } from "../../store/authStore";
import {
  useUpdateProfile,
  useUpdatePresence,
  useUploadAvatar,
  useUploadBanner,
  useUpdateUsername,
  useUpdatePassword,
  useDeleteAccount,
  useExportAccountData,
} from "../../queries/users";
import {
  useLogout,
  useSessions,
  useRevokeSession,
  useRevokeOtherSessions,
  useResendVerification,
} from "../../queries/auth";
import {
  useMyApplications,
  useCreateApplication,
  useRegenerateBotToken,
  useDeleteApplication,
  useUpdateRedirectUris,
  useRegenerateClientSecret,
} from "../../queries/applications";
import { UserAvatar } from "../common/UserAvatar";
import type { PresenceStatus } from "@lumina/shared";
import { cn } from "../../lib/cn";
import { ApiError, resolveAssetUrl } from "../../lib/apiClient";
import { isWebPushSupported, getPushSubscriptionStatus, subscribeToPush, unsubscribeFromPush } from "../../lib/webPush";
import { BillingSection } from "./BillingSection";
import { AdvertisingSection } from "./AdvertisingSection";

const PRESENCE_OPTIONS: PresenceStatus[] = ["ONLINE", "IDLE", "DND"];

type Section = "account" | "sessions" | "appearance" | "privacy" | "notifications" | "billing" | "advertising" | "developer" | "voice";

const SECTIONS: Array<{ key: Section; label: string; icon: typeof User }> = [
  { key: "account", label: "My Account", icon: User },
  { key: "sessions", label: "Devices & Sessions", icon: Monitor },
  { key: "appearance", label: "Appearance", icon: Palette },
  { key: "privacy", label: "Privacy & Safety", icon: ShieldCheck },
  { key: "notifications", label: "Notifications", icon: Bell },
  { key: "billing", label: "Billing", icon: CreditCard },
  { key: "advertising", label: "Advertising", icon: Megaphone },
  { key: "developer", label: "Developer Portal", icon: Code2 },
  { key: "voice", label: "Voice & Video", icon: Mic },
];

function UsernameEditor() {
  const user = useAuthStore((s) => s.user);
  const updateUsername = useUpdateUsername();
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState(user?.username ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!user) return null;

  async function submit() {
    setError(null);
    setSuccess(false);
    try {
      await updateUsername.mutateAsync({ username: username.trim(), currentPassword });
      setSuccess(true);
      setCurrentPassword("");
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to change username");
    }
  }

  if (!editing) {
    return (
      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Username</span>
        <div className="mt-1.5 flex items-center justify-between rounded bg-base-900 px-3 py-2">
          <span className="text-signal">@{user.username}</span>
          <button
            onClick={() => {
              setUsername(user.username);
              setEditing(true);
              setSuccess(false);
            }}
            className="text-xs font-medium text-accent hover:underline"
          >
            Change
          </button>
        </div>
        {success ? <p className="mt-1.5 text-xs text-online">Username updated.</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded bg-base-900 p-3">
      {/* The visible label is a <span>, which associates with nothing — these inputs had no
          accessible name at all, so assistive tech announced them as bare edit fields and a
          "current password" box was indistinguishable from any other. aria-label gives them one
          without changing the layout. */}
      <span className="text-xs font-bold uppercase text-signal-dim">New username</span>
      <input
        aria-label="New username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="rounded bg-base-700 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
      />
      <span className="mt-1 text-xs font-bold uppercase text-signal-dim">Current password</span>
      <input
        type="password"
        aria-label="Current password for username change"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        placeholder="Confirm with your password"
        className="rounded bg-base-700 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
      />
      {error ? <p className="text-xs text-dnd">{error}</p> : null}
      <div className="flex gap-2">
        <button
          onClick={() => void submit()}
          disabled={updateUsername.isPending || !username.trim() || !currentPassword}
          className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          Save
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          className="rounded px-3 py-1.5 text-xs font-medium text-signal-dim hover:bg-base-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function PasswordEditor() {
  const updatePassword = useUpdatePassword();
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function submit() {
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match");
      return;
    }
    try {
      await updatePassword.mutateAsync({ currentPassword, newPassword });
      setSuccess(true);
      setOpen(false);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to change password");
    }
  }

  if (!open) {
    return (
      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Password</span>
        <div className="mt-1.5 flex items-center justify-between rounded bg-base-900 px-3 py-2">
          <span className="text-signal">••••••••</span>
          <button
            onClick={() => {
              setOpen(true);
              setSuccess(false);
            }}
            className="text-xs font-medium text-accent hover:underline"
          >
            Change
          </button>
        </div>
        {success ? <p className="mt-1.5 text-xs text-online">Password updated.</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded bg-base-900 p-3">
      <span className="text-xs font-bold uppercase text-signal-dim">Current password</span>
      <input
        type="password"
        aria-label="Current password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        className="rounded bg-base-700 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
      />
      <span className="mt-1 text-xs font-bold uppercase text-signal-dim">New password</span>
      <input
        type="password"
        aria-label="New password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        className="rounded bg-base-700 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
      />
      <span className="mt-1 text-xs font-bold uppercase text-signal-dim">Confirm new password</span>
      <input
        type="password"
        aria-label="Confirm new password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        className="rounded bg-base-700 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
      />
      {error ? <p className="text-xs text-dnd">{error}</p> : null}
      <div className="flex gap-2">
        <button
          onClick={() => void submit()}
          disabled={updatePassword.isPending || !currentPassword || !newPassword}
          className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          Save
        </button>
        <button
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="rounded px-3 py-1.5 text-xs font-medium text-signal-dim hover:bg-base-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function StatusEmojiPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded bg-base-900 text-lg ring-1 ring-base-500 hover:bg-base-700"
          title="Status emoji"
        >
          {value || "🙂"}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="bottom" align="start" className="z-50 grid grid-cols-5 gap-1 rounded-md bg-base-600 p-2 shadow-lg">
          {value ? (
            <DropdownMenu.Item
              onSelect={() => onChange("")}
              className="col-span-5 cursor-pointer rounded px-2 py-1 text-center text-xs text-signal-dim outline-none hover:bg-base-500"
            >
              Clear
            </DropdownMenu.Item>
          ) : null}
          {COMMON_EMOJIS.map((emoji) => (
            <DropdownMenu.Item
              key={emoji}
              onSelect={() => onChange(emoji)}
              className="cursor-pointer rounded p-1.5 text-lg outline-none hover:bg-base-500"
            >
              {emoji}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function AccountSection() {
  const user = useAuthStore((s) => s.user);
  const updateProfile = useUpdateProfile();
  const updatePresence = useUpdatePresence();
  const uploadAvatar = useUploadAvatar();
  const uploadBanner = useUploadBanner();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [statusText, setStatusText] = useState(user?.statusText ?? "");
  const [statusEmoji, setStatusEmoji] = useState(user?.statusEmoji ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [pronouns, setPronouns] = useState(user?.pronouns ?? "");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  if (!user) return null;

  return (
    <div className="flex flex-col gap-5">
      <button
        onClick={() => bannerInputRef.current?.click()}
        disabled={uploadBanner.isPending}
        aria-label={user.bannerUrl ? "Change your banner" : "Add a banner"}
        className="group relative flex h-24 w-full items-center justify-center overflow-hidden rounded-lg bg-base-900"
        style={user.bannerUrl ? { backgroundImage: `url(${resolveAssetUrl(user.bannerUrl)})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
      >
        {/* The upload is re-encoded server-side (crop + compress), so a large photo takes a
            visible moment. Without a pending state the button looks like it did nothing. */}
        {uploadBanner.isPending ? (
          <span className="absolute inset-0 flex items-center justify-center gap-2 bg-black/60 text-xs font-medium text-white">
            <Loader2 className="h-4 w-4 animate-spin" />
            Fitting your banner...
          </span>
        ) : (
          <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-xs font-medium text-transparent group-hover:bg-black/50 group-hover:text-white">
            {user.bannerUrl ? "Change banner" : "Add a banner"}
          </span>
        )}
      </button>
      <input
        ref={bannerInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) uploadBanner.mutate(file);
        }}
      />

      <p className="-mt-3 text-xs text-signal-faint">
        Any shape works — pictures are cropped around whatever the image is actually of, not
        blindly around the middle.
      </p>

      <div className="flex items-center gap-4">
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadAvatar.isPending}
          aria-label="Change your avatar"
          className="relative"
        >
          <UserAvatar avatarUrl={user.avatarUrl} name={user.displayName ?? user.username} size={72} presence={user.presence} />
          {uploadAvatar.isPending ? (
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/60">
              <Loader2 className="h-5 w-5 animate-spin text-white" />
            </span>
          ) : (
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 text-[10px] font-medium text-transparent hover:bg-black/50 hover:text-white">
              Change
            </span>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) uploadAvatar.mutate(file);
          }}
        />
        <div>
          <div className="text-lg font-semibold text-signal">{user.displayName ?? user.username}</div>
          <div className="text-sm text-signal-dim">@{user.username}</div>
        </div>
      </div>

      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Presence</span>
        <div className="mt-1.5 flex gap-2">
          {PRESENCE_OPTIONS.map((p) => (
            <button
              key={p}
              onClick={() => updatePresence.mutate(p)}
              className={cn(
                "rounded px-3 py-1.5 text-xs font-medium",
                user.presence === p ? "bg-accent text-white" : "bg-base-900 text-signal-dim hover:bg-base-700",
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-bold uppercase text-signal-dim">Display name</span>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="rounded bg-base-900 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-bold uppercase text-signal-dim">Pronouns</span>
        <input
          value={pronouns}
          onChange={(e) => setPronouns(e.target.value)}
          maxLength={40}
          placeholder="e.g. they/them"
          className="rounded bg-base-900 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-bold uppercase text-signal-dim">Status</span>
        <div className="flex gap-2">
          <StatusEmojiPicker value={statusEmoji} onChange={setStatusEmoji} />
          <input
            value={statusText}
            onChange={(e) => setStatusText(e.target.value)}
            className="min-w-0 flex-1 rounded bg-base-900 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
            placeholder="What's happening?"
          />
        </div>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-bold uppercase text-signal-dim">About me</span>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={190}
          rows={3}
          placeholder="Tell people a bit about yourself"
          className="resize-none rounded bg-base-900 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
        />
        <span className="self-end text-[10px] text-signal-faint">{bio.length}/190</span>
      </label>

      <button
        onClick={() =>
          updateProfile.mutate({
            displayName: displayName || null,
            statusText: statusText || null,
            statusEmoji: statusEmoji || null,
            bio: bio || null,
            pronouns: pronouns || null,
          })
        }
        disabled={updateProfile.isPending}
        className="w-fit rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
      >
        Save changes
      </button>

      <div className="mt-2 flex flex-col gap-3 border-t border-base-900/60 pt-4">
        <EmailVerificationRow />
        <UsernameEditor />
        <PasswordEditor />
      </div>

      <DangerZoneSection />
    </div>
  );
}

/**
 * Email address and its verification state, with the Resend button the rest of the app already
 * pointed at.
 *
 * This is not cosmetic. A server set to any verification level above NONE refuses posts from an
 * unverified account (see modules/servers/verification.ts), so without this row the answer to "why
 * can't I post" lived only in an error message, and the fix it named did not exist.
 *
 * The server's own wording is shown verbatim on failure — it distinguishes "a link was just sent",
 * "this server has no mail server configured" and a genuine send failure, and those are three
 * different things for the person reading them.
 */
function EmailVerificationRow() {
  const user = useAuthStore((s) => s.user);
  const resend = useResendVerification();
  const [message, setMessage] = useState<string | null>(null);

  if (!user) return null;

  if (user.emailVerified) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <ShieldCheck className="h-4 w-4 shrink-0 text-pulse" />
        <span className="text-signal-dim">Email verified</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber/40 bg-amber/10 p-3">
      <div className="flex items-start gap-2">
        <MailWarning className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-signal">Email not verified</p>
          <p className="mt-0.5 text-xs leading-relaxed text-signal-dim">
            Some servers require a verified address before you can post. Check your inbox — including
            spam — or send a new link.
          </p>
          <button
            type="button"
            disabled={resend.isPending}
            onClick={() => {
              setMessage(null);
              resend.mutate(undefined, {
                onSuccess: (r) =>
                  setMessage(
                    r.alreadyVerified
                      ? "That address is already verified — reload to update this page."
                      : "Link sent. It's valid for 24 hours.",
                  ),
                onError: (e) =>
                  setMessage(e instanceof ApiError ? e.message : "Couldn't send the email."),
              });
            }}
            className="mt-2 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {resend.isPending ? "Sending…" : "Resend verification email"}
          </button>
          {message && <p className="mt-2 text-xs text-signal-dim">{message}</p>}
        </div>
      </div>
    </div>
  );
}

/** Both routes (GET /users/me/export, DELETE /users/me) previously didn't exist at all —
 * account deletion in particular needed a real decision (hard-delete, consistent with the
 * existing "deleted user's content survives via nullable authorId" precedent — see
 * users/routes.ts's comment on the DELETE /me route) before it could be built at all. */
function DangerZoneSection() {
  const deleteAccount = useDeleteAccount();
  const exportData = useExportAccountData();
  const [showDelete, setShowDelete] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setError(null);
    try {
      await deleteAccount.mutateAsync(password);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to delete account");
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-3 border-t border-base-900/60 pt-4">
      <span className="text-xs font-bold uppercase text-dnd">Danger zone</span>

      <div className="flex items-center justify-between gap-4 rounded-lg bg-base-900 px-4 py-3">
        <div>
          <p className="text-sm font-medium text-signal">Download your data</p>
          <p className="text-xs text-signal-dim">Export your profile, messages, and server memberships as a JSON file.</p>
        </div>
        <button
          onClick={() => void exportData.mutateAsync()}
          disabled={exportData.isPending}
          className="shrink-0 rounded bg-base-700 px-3 py-1.5 text-xs font-medium text-signal hover:bg-base-600 disabled:opacity-50"
        >
          Export
        </button>
      </div>

      {!showDelete ? (
        <button onClick={() => setShowDelete(true)} className="w-fit text-sm font-medium text-dnd hover:underline">
          Delete account
        </button>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg bg-base-900 p-3">
          <p className="text-sm text-signal">
            This permanently deletes your account. It can't be undone. Transfer or delete any servers you own first.
          </p>
          <input
            aria-label="Confirm your password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Confirm with your password"
            className="rounded bg-base-700 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-dnd"
          />
          {error ? <p className="text-xs text-dnd">{error}</p> : null}
          <div className="flex gap-2">
            <button
              onClick={() => void handleDelete()}
              disabled={deleteAccount.isPending || !password}
              className="rounded bg-dnd px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Permanently delete my account
            </button>
            <button
              onClick={() => {
                setShowDelete(false);
                setError(null);
                setPassword("");
              }}
              className="rounded px-3 py-1.5 text-xs font-medium text-signal-dim hover:bg-base-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const ACCENT_THEME_LABELS: Record<AccentTheme, string> = {
  aurora: "Aurora",
  crimson: "Crimson",
  forest: "Forest",
  solar: "Solar",
  ocean: "Ocean",
};

// Swatch preview colors — kept in sync BY HAND with index.css's dark-mode --ion/--aurora
// values for each accent theme (there's no clean way to read a CSS custom property for an
// attribute value that isn't currently applied to the document, so this can't just reuse the
// real tokens). If a theme's colors ever change in index.css, update this map too.
const ACCENT_THEME_SWATCH: Record<AccentTheme, [string, string]> = {
  aurora: ["#5b7cfa", "#a45cf5"],
  crimson: ["#e14a6b", "#f5735c"],
  forest: ["#3fae7a", "#7fd858"],
  solar: ["#e2963f", "#f5cf5c"],
  ocean: ["#2f9bd6", "#4fd8e8"],
};

/** Label, one-line rationale, and a swatch of each theme's actual surface colours (mirroring the
 * values in index.css) so the picker previews the theme rather than naming it. */
const THEME_META: Record<Theme, { label: string; note: string; bg: string; panel: string; raised: string; accent: string }> = {
  dark: { label: "Nebula", note: "The default violet-cast dark", bg: "#0c0a17", panel: "#16121f", raised: "#2a2340", accent: "#5b7cfa" },
  midnight: { label: "Midnight", note: "True black — best on OLED", bg: "#000000", panel: "#0a0a0d", raised: "#1c1c23", accent: "#5b7cfa" },
  carbon: { label: "Carbon", note: "Neutral grey, no colour cast", bg: "#0d0f12", panel: "#14171b", raised: "#262b33", accent: "#5b7cfa" },
  moss: { label: "Moss", note: "Warm green, easiest on the eyes", bg: "#0a1010", panel: "#101917", raised: "#1f2f2a", accent: "#5b7cfa" },
  light: { label: "Daylight", note: "The default light mode", bg: "#f3f1fb", panel: "#ffffff", raised: "#e0daf3", accent: "#4a63e0" },
  slate: { label: "Slate", note: "Cool and low-saturation", bg: "#eef1f5", panel: "#ffffff", raised: "#d6dde7", accent: "#2f6fed" },
  parchment: { label: "Parchment", note: "Warm paper tones", bg: "#f5f1e8", panel: "#fffdf8", raised: "#e5ddcc", accent: "#4a63e0" },
};

function AppearanceSection() {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const accentTheme = useUIStore((s) => s.accentTheme);
  const setAccentTheme = useUIStore((s) => s.setAccentTheme);
  const density = useUIStore((s) => s.density);
  const setDensity = useUIStore((s) => s.setDensity);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Theme</span>
        <p className="mb-2 text-sm text-signal-faint">
          Changes every surface in the app, not just the highlight colour.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {THEMES.map((t) => {
            const meta = THEME_META[t];
            const active = theme === t;
            return (
              <button
                key={t}
                onClick={() => setTheme(t)}
                aria-pressed={active}
                className={cn(
                  "flex flex-col gap-1.5 rounded-lg border p-2 text-left transition",
                  active ? "border-accent" : "border-base-500 hover:border-base-400",
                )}
              >
                {/* Live swatch of the theme's own surfaces, so the choice is made by looking
                    rather than by guessing what "carbon" means. */}
                <span className="flex h-8 overflow-hidden rounded" style={{ background: meta.bg }}>
                  <span className="w-1/4" style={{ background: meta.panel }} />
                  <span className="w-1/4" style={{ background: meta.raised }} />
                  <span className="my-2 ml-auto mr-2 w-2 self-center rounded-full" style={{ background: meta.accent, height: "0.5rem" }} />
                </span>
                <span className="flex items-center gap-1 text-xs font-medium text-signal">
                  {LIGHT_THEMES.includes(t) ? <Sun size={12} /> : <Moon size={12} />}
                  {meta.label}
                </span>
                <span className="text-[10px] leading-tight text-signal-faint">{meta.note}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Accent color</span>
        <p className="mb-2 text-sm text-signal-faint">Recolors buttons, links, and highlights across the app.</p>
        <div className="flex flex-wrap gap-2">
          {ACCENT_THEMES.map((t) => {
            const [c1, c2] = ACCENT_THEME_SWATCH[t];
            return (
              <button
                key={t}
                onClick={() => setAccentTheme(t)}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ring-1",
                  accentTheme === t ? "bg-base-700 text-signal ring-accent" : "bg-base-900 text-signal-dim ring-transparent hover:bg-base-700",
                )}
              >
                <span
                  className="h-4 w-4 shrink-0 rounded-full"
                  style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}
                />
                {ACCENT_THEME_LABELS[t]}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Message density</span>
        <p className="mb-2 text-sm text-signal-faint">How tightly messages are packed in the chat pane.</p>
        <div className="flex w-fit overflow-hidden rounded-lg border border-base-500 bg-base-900">
          <button
            onClick={() => setDensity("comfortable")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium",
              density === "comfortable" ? "bg-grad text-white" : "text-signal-dim hover:text-signal",
            )}
          >
            <AlignJustify size={14} /> Comfortable
          </button>
          <button
            onClick={() => setDensity("compact")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium",
              density === "compact" ? "bg-grad text-white" : "text-signal-dim hover:text-signal",
            )}
          >
            <Rows3 size={14} /> Compact
          </button>
        </div>
      </div>
    </div>
  );
}

function RevealedToken({ label, token, hint }: { label: string; token: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1 rounded bg-base-900 p-2.5">
      <span className="text-xs text-signal-faint">
        {label} — copy it now, it won't be shown again. {hint ?? (
          <>Send it as <code>Authorization: Bot {"<token>"}</code>.</>
        )}
      </span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate text-xs text-signal">{token}</code>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(token);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="shrink-0 text-signal-dim hover:text-signal"
        >
          {copied ? <Check size={15} className="text-online" /> : <Copy size={15} />}
        </button>
      </div>
    </div>
  );
}

/** Redirect URI allowlist editor + client secret generation for one Application — the OAuth2
 * side of the Dev Portal (see modules/oauth2/ for the full authorization-code flow this feeds).
 * Local draft list + explicit Save rather than saving per-keystroke, since this is a security-
 * relevant allowlist (Application.redirectUris) — accidental partial saves would be worse than
 * a plain modal form. */
function OAuthSettings({ app }: { app: import("@lumina/shared").ApplicationDTO }) {
  const [draftUris, setDraftUris] = useState(app.redirectUris);
  const [newUri, setNewUri] = useState("");
  const updateUris = useUpdateRedirectUris();
  const regenerateSecret = useRegenerateClientSecret();
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const dirty = JSON.stringify(draftUris) !== JSON.stringify(app.redirectUris);

  return (
    <div className="flex flex-col gap-2 rounded border border-base-500/60 p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase text-signal-dim">OAuth2</span>
        <code className="text-[10px] text-signal-faint">client_id: {app.id}</code>
      </div>

      <span className="text-xs text-signal-faint">Redirect URIs (exact match required)</span>
      {draftUris.map((uri) => (
        <div key={uri} className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate text-xs text-signal">{uri}</code>
          <button
            onClick={() => setDraftUris((list) => list.filter((u) => u !== uri))}
            className="shrink-0 text-signal-dim hover:text-dnd"
            title="Remove"
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <input
          aria-label="New redirect URI"
          value={newUri}
          onChange={(e) => setNewUri(e.target.value)}
          placeholder="https://yourapp.example.com/callback"
          className="min-w-0 flex-1 rounded bg-base-900 px-2 py-1 text-xs text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
        />
        <button
          onClick={() => {
            if (!newUri.trim() || draftUris.includes(newUri.trim())) return;
            setDraftUris((list) => [...list, newUri.trim()]);
            setNewUri("");
          }}
          className="shrink-0 rounded bg-base-600 px-2 py-1 text-xs font-medium text-signal hover:bg-base-500"
        >
          Add
        </button>
      </div>
      {dirty && (
        <button
          onClick={() => updateUris.mutate({ applicationId: app.id, redirectUris: draftUris })}
          disabled={updateUris.isPending}
          className="w-fit rounded bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          Save redirect URIs
        </button>
      )}

      <div className="mt-1 flex items-center justify-between">
        <span className="text-xs text-signal-faint">
          {app.hasClientSecret ? "Client secret is set." : "No client secret yet."}
        </span>
        <button
          onClick={async () => {
            const result = await regenerateSecret.mutateAsync(app.id);
            setRevealedSecret(result.clientSecret);
          }}
          disabled={draftUris.length === 0 || regenerateSecret.isPending}
          title={draftUris.length === 0 ? "Add a redirect URI first" : undefined}
          className="rounded bg-base-600 px-2 py-1 text-xs font-medium text-signal hover:bg-base-500 disabled:opacity-50"
        >
          {app.hasClientSecret ? "Regenerate secret" : "Generate secret"}
        </button>
      </div>
      {revealedSecret ? (
        <RevealedToken label="Client secret" token={revealedSecret} hint="Use it server-side only, to exchange a code at POST /api/oauth2/token." />
      ) : null}
    </div>
  );
}

function DeveloperPortalSection() {
  const { data: apps, isLoading } = useMyApplications(true);
  const createApp = useCreateApplication();
  const regenerateToken = useRegenerateBotToken();
  const deleteApp = useDeleteApplication();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [newToken, setNewToken] = useState<{ id: string; token: string } | null>(null);
  const [regeneratedToken, setRegeneratedToken] = useState<{ id: string; token: string } | null>(null);

  async function handleCreate() {
    if (!name.trim()) return;
    const result = await createApp.mutateAsync({ name: name.trim(), description: description.trim() || null });
    setNewToken({ id: result.id, token: result.botToken });
    setName("");
    setDescription("");
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-signal-dim">
        Create bot accounts for Lumina. A bot is a real member — invite it to a server like any user, assign it roles, and it's
        bound by exactly those permissions. See the full <a href="/api/docs" target="_blank" rel="noreferrer" className="text-accent hover:underline">API reference</a>.
      </p>

      <div className="flex flex-col gap-2 rounded-lg border border-base-500 p-3">
        <span className="text-xs font-bold uppercase text-signal-dim">New application</span>
        <input
          aria-label="Application name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Bot name"
          className="rounded bg-base-900 px-2 py-1.5 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
        />
        <input
          aria-label="Application description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          className="rounded bg-base-900 px-2 py-1.5 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
        />
        <button
          onClick={() => void handleCreate()}
          disabled={!name.trim() || createApp.isPending}
          className="w-fit rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          Create
        </button>
        {newToken ? <RevealedToken label="Bot token" token={newToken.token} /> : null}
      </div>

      <div className="flex flex-col gap-2">
        {isLoading ? (
          <p className="text-sm text-signal-faint">Loading…</p>
        ) : apps?.length ? (
          apps.map((app) => (
            <div key={app.id} className="flex flex-col gap-2 rounded bg-base-900 px-3 py-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Bot size={16} className="shrink-0 text-signal-faint" />
                  <div className="min-w-0">
                    <div className="truncate text-signal">{app.name}</div>
                    <div className="truncate text-xs text-signal-faint">@{app.botUsername}</div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={async () => {
                      const result = await regenerateToken.mutateAsync(app.id);
                      setRegeneratedToken({ id: app.id, token: result.botToken });
                    }}
                    title="Regenerate token"
                    className="rounded p-1.5 text-signal-dim hover:bg-base-700 hover:text-signal"
                  >
                    <RefreshCw size={15} />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete "${app.name}"? Its bot account will be removed from every server it's in.`)) {
                        deleteApp.mutate(app.id);
                      }
                    }}
                    title="Delete"
                    className="rounded p-1.5 text-signal-dim hover:bg-base-700 hover:text-dnd"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              {regeneratedToken?.id === app.id ? <RevealedToken label="New bot token" token={regeneratedToken.token} /> : null}
              <OAuthSettings app={app} />
            </div>
          ))
        ) : (
          <p className="text-sm text-signal-faint">No applications yet.</p>
        )}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-base-900 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-signal">{label}</p>
        <p className="text-xs text-signal-dim">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50",
          checked ? "bg-accent" : "bg-base-500",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-[22px]" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}

function PrivacySection() {
  const user = useAuthStore((s) => s.user);
  const updateProfile = useUpdateProfile();
  const closeModal = useUIStore((s) => s.closeModal);
  const navigate = useNavigate();

  if (!user) return null;

  return (
    <div className="flex flex-col gap-5">
      {/* First in the section, not last: it is the only control here that protects the account
          itself rather than tuning who may contact it. */}
      {/* Native builds only — the web app uses passkeys instead, which are a stronger mechanism
          and available there. */}
      <BiometricLockSetting />

      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Two-factor authentication</span>
        <div className="mt-2">
          <MfaSetup />
        </div>
      </div>

      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Who can contact you</span>
        <div className="mt-2 flex flex-col gap-2">
          <ToggleRow
            label="Friend requests"
            description="Allow anyone to send you a friend request by username. Turning this off doesn't cancel requests already pending."
            checked={user.allowFriendRequests ?? true}
            disabled={updateProfile.isPending}
            onChange={(next) => updateProfile.mutate({ allowFriendRequests: next })}
          />
          <ToggleRow
            label="Direct messages from non-friends"
            description="Allow anyone to start a new DM with you, not just friends. Existing conversations are never affected."
            checked={user.allowDmsFromNonFriends ?? true}
            disabled={updateProfile.isPending}
            onChange={(next) => updateProfile.mutate({ allowDmsFromNonFriends: next })}
          />
        </div>
      </div>

      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Blocked users</span>
        <p className="mb-2 text-sm text-signal-faint">
          Blocked users can't friend or DM you. Manage your block list from the Friends view.
        </p>
        <button
          onClick={() => {
            closeModal();
            navigate("/friends?tab=blocked");
          }}
          className="rounded bg-base-900 px-3 py-2 text-sm font-medium text-signal hover:bg-base-700"
        >
          View blocked users
        </button>
      </div>
    </div>
  );
}

function NotificationsSection() {
  const [status, setStatus] = useState<"loading" | "unsupported" | "denied" | "subscribed" | "unsubscribed">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isWebPushSupported()) {
      setStatus("unsupported");
      return;
    }
    getPushSubscriptionStatus().then(setStatus);
  }, []);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (status === "subscribed") {
        await unsubscribeFromPush();
        setStatus("unsubscribed");
      } else {
        await subscribeToPush();
        setStatus("subscribed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update notification settings");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Push notifications</span>
        <p className="mb-2 text-sm text-signal-faint">
          Get a real browser/device notification for new DMs, @mentions, and friend requests — even when Lumina isn't the
          active tab.
        </p>
        {status === "unsupported" ? (
          <p className="text-sm text-signal-faint">Not supported in this browser.</p>
        ) : status === "denied" ? (
          <p className="text-sm text-dnd">
            Notifications are blocked for this site — enable them in your browser's site settings, then reopen this page.
          </p>
        ) : (
          <ToggleRow
            label="Enable push notifications"
            description={status === "subscribed" ? "You'll be notified on this device." : "Off for this device."}
            checked={status === "subscribed"}
            disabled={busy || status === "loading"}
            onChange={() => void toggle()}
          />
        )}
        {error ? <p className="mt-2 text-xs text-dnd">{error}</p> : null}
      </div>

      <NotificationSoundToggle />
    </div>
  );
}

/** Client-side only (localStorage, like density/theme) — no server-side sound-file concept, the
 * "sound" is a short synthesized tone (lib/notificationSound.ts), not a bundled asset. */
function NotificationSoundToggle() {
  const enabled = useUIStore((s) => s.notificationSoundEnabled);
  const setEnabled = useUIStore((s) => s.setNotificationSoundEnabled);
  return (
    <div>
      <span className="text-xs font-bold uppercase text-signal-dim">Sound</span>
      <p className="mb-2 text-sm text-signal-faint">Play a sound for new DMs and @mentions.</p>
      <ToggleRow
        label="Notification sound"
        description={enabled ? "On" : "Off"}
        checked={enabled}
        onChange={setEnabled}
      />
    </div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** RefreshToken already had userAgent/ipAddress/revokedAt with zero routes/UI surfacing them —
 * see auth/routes.ts's new GET/DELETE /auth/sessions. "Current session" is only reliably known
 * for the web client (the refresh token rides an httpOnly cookie the sessions route can compare
 * against); mobile/desktop rows just never show the badge, which is an honest limitation rather
 * than a guess. */
function SessionsSection() {
  const { data: sessions } = useSessions();
  const revokeSession = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs font-bold uppercase text-signal-dim">Active sessions</span>
          <p className="text-sm text-signal-faint">Devices and browsers currently logged into your account.</p>
        </div>
        <button
          onClick={() => void revokeOthers.mutateAsync()}
          disabled={revokeOthers.isPending || (sessions?.length ?? 0) <= 1}
          className="shrink-0 rounded bg-base-900 px-3 py-1.5 text-xs font-medium text-signal hover:bg-base-700 disabled:opacity-50"
        >
          Log out other devices
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        {(sessions ?? []).map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-3 rounded-lg bg-base-900 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-signal">
                {s.userAgent ?? "Unknown device"}
                {s.isCurrent ? <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">This device</span> : null}
              </p>
              <p className="text-xs text-signal-faint">
                {s.ipAddress ?? "Unknown IP"} — active {timeAgo(s.createdAt)}
              </p>
            </div>
            {!s.isCurrent && (
              <button
                onClick={() => void revokeSession.mutateAsync(s.id)}
                className="shrink-0 rounded p-1.5 text-signal-dim hover:bg-base-500 hover:text-dnd"
                title="Log out this device"
              >
                <LogOut size={15} />
              </button>
            )}
          </div>
        ))}
        {sessions?.length === 0 ? <p className="text-sm text-signal-faint">No active sessions.</p> : null}
      </div>
    </div>
  );
}

function PlaceholderSection({ icon: Icon, title, body }: { icon: typeof User; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <Icon size={32} className="text-signal-faint" />
      <p className="text-sm font-semibold text-signal">{title}</p>
      <p className="max-w-sm text-sm text-signal-dim">{body}</p>
    </div>
  );
}

function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

/** No keybind system existed at all before this — a top-level keydown listener in
 * AppShell.tsx checks these against uiStore's `keybinds`. "Listening…" capture mode records
 * the next real keydown via `e.code` (physical key, layout-independent) rather than `e.key`. */
function KeybindRow({ label, action }: { label: string; action: keyof import("../../store/uiStore").Keybinds }) {
  const value = useUIStore((s) => s.keybinds[action]);
  const setKeybind = useUIStore((s) => s.setKeybind);
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      setKeybind(action, e.code);
      setListening(false);
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening]);

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-base-900 px-4 py-3">
      <span className="text-sm font-medium text-signal">{label}</span>
      <button
        onClick={() => setListening(true)}
        className={cn(
          "min-w-20 rounded px-3 py-1.5 text-xs font-medium",
          listening ? "bg-accent text-white" : "bg-base-700 text-signal hover:bg-base-600",
        )}
      >
        {listening ? "Press a key…" : keyLabel(value)}
      </button>
    </div>
  );
}

function VoiceSection() {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-signal-dim">
        Join any voice channel from the server sidebar to talk, share your camera, or share your screen.
      </p>
      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Keybinds</span>
        <p className="mb-2 text-sm text-signal-faint">Work anywhere in the app while you're in a voice call.</p>
        <div className="flex flex-col gap-1.5">
          <KeybindRow label="Toggle mute" action="toggleMute" />
          <KeybindRow label="Toggle deafen" action="toggleDeafen" />
        </div>
      </div>
    </div>
  );
}

export function UserSettingsModal() {
  const openModal = useUIStore((s) => s.openModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const open = openModal === "userSettings";
  const logout = useLogout();
  const [section, setSection] = useState<Section>("account");

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && closeModal()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-base-900 data-[state=open]:animate-in data-[state=open]:fade-in" />
        <Dialog.Content className="fixed inset-0 z-50 flex focus:outline-none">
          <Dialog.Title className="sr-only">User Settings</Dialog.Title>
          <div className="flex w-60 shrink-0 flex-col gap-0.5 border-r border-base-900/60 bg-base-800 p-3 max-md:w-16">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                title={s.label}
                className={cn(
                  "flex items-center gap-2.5 rounded px-3 py-2 text-left text-sm font-medium max-md:justify-center",
                  section === s.key ? "bg-base-600 text-signal" : "text-signal-dim hover:bg-base-700 hover:text-signal",
                )}
              >
                <s.icon size={17} className="shrink-0" />
                <span className="max-md:hidden">{s.label}</span>
              </button>
            ))}
            <div className="mt-auto border-t border-base-900/60 pt-3">
              <button
                onClick={() => logout.mutate()}
                title="Log Out"
                className="flex w-full items-center gap-2.5 rounded px-3 py-2 text-left text-sm font-medium text-dnd hover:bg-base-700 max-md:justify-center"
              >
                <LogOut size={17} className="shrink-0" />
                <span className="max-md:hidden">Log Out</span>
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-2xl px-8 py-10">
              <div className="mb-6 flex items-center justify-between">
                <h1 className="text-xl font-bold text-signal">{SECTIONS.find((s) => s.key === section)?.label}</h1>
                <Dialog.Close asChild>
                  <button className="text-signal-dim hover:text-signal">
                    <X size={22} />
                  </button>
                </Dialog.Close>
              </div>

              {section === "account" && <AccountSection />}
              {section === "sessions" && <SessionsSection />}
              {section === "appearance" && <AppearanceSection />}
              {section === "privacy" && <PrivacySection />}
              {section === "notifications" && <NotificationsSection />}
              {section === "billing" && <BillingSection />}
              {section === "advertising" && <AdvertisingSection />}
              {section === "developer" && <DeveloperPortalSection />}
              {section === "voice" && <VoiceSection />}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The native app lock toggle.
 *
 * Renders nothing on web and desktop, where passkeys already provide a stronger equivalent, and
 * nothing on a device with no biometric configured — with the reason shown when that reason is
 * something the user can fix.
 */
function BiometricLockSetting() {
  const [state, setState] = useState<{ available: boolean; reason: string } | null>(null);
  const [enabled, setEnabled] = useState(isBiometricLockEnabled());

  useEffect(() => {
    let cancelled = false;
    void biometricAvailability().then((r) => {
      if (!cancelled) setState(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state || state.reason === "not-native" || state.reason === "plugin-missing") return null;

  return (
    <div>
      <span className="text-xs font-bold uppercase text-signal-dim">App lock</span>
      {state.available ? (
        <div className="mt-2">
          <ToggleRow
            label="Require fingerprint or face to open Lumina"
            description="Locks the app on open, and again after it has been in the background for a while."
            checked={enabled}
            onChange={async (next) => {
              // Prove it works BEFORE turning it on. Enabling a lock the device cannot satisfy
              // means the next launch is unopenable, and the only way out is reinstalling.
              if (next && !(await requestBiometricUnlock("Confirm to turn on the app lock"))) return;
              setBiometricLockEnabled(next);
              setEnabled(next);
            }}
          />
          <p className="mt-1.5 text-xs text-signal-faint">
            A convenience lock: it stops someone picking up your unlocked phone, but it does not
            encrypt anything stored on the device.
          </p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-signal-faint">
          {state.reason === "none-enrolled"
            ? "Set up a fingerprint, face unlock or screen lock in your phone's settings to use this."
            : "This device doesn't support biometric unlock."}
        </p>
      )}
    </div>
  );
}
