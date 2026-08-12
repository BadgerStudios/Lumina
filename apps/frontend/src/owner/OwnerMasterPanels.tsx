import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Crown, ShieldCheck, User as UserIcon, Loader2, Upload, CheckCircle2, XCircle, FileText } from "lucide-react";
import type { PlatformRole, UserDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { useAuthStore } from "../store/authStore";
import { UserAvatar } from "../components/common/UserAvatar";
import { UserSearchInput } from "../components/common/UserSearchInput";
import { SectionHeading, StatTile, formatBytes } from "./OwnerBusinessPanels";
import { cn } from "../lib/cn";
import { isMaster } from "../lib/platformRole";

interface TeamMember extends UserDTO {
  email: string;
  platformRole: PlatformRole;
  createdAt: string;
  activity: { videosReviewed: number; staffActions: number };
}

const ROLE_META: Record<PlatformRole, { label: string; icon: typeof Crown; className: string }> = {
  MASTER: { label: "Master", icon: Crown, className: "text-amber" },
  OWNER: { label: "Owner", icon: Crown, className: "text-aurora" },
  STAFF: { label: "Staff", icon: ShieldCheck, className: "text-accent" },
  USER: { label: "User", icon: UserIcon, className: "text-signal-faint" },
};

function useTeam() {
  return useQuery({
    queryKey: ["master", "team"],
    queryFn: () => api.get<{ assignableRoles: PlatformRole[]; team: TeamMember[] }>("/master/team"),
  });
}

function useGrantRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, platformRole }: { userId: string; platformRole: PlatformRole }) =>
      api.post<{ id: string; username: string; platformRole: PlatformRole }>("/master/grant", {
        userId,
        platformRole,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["master"] });
      void queryClient.invalidateQueries({ queryKey: ["owner"] });
    },
  });
}

/**
 * Team management — who holds staff and owner access.
 *
 * Granting is a typeahead search rather than a paste-the-user-id box, because appointing staff means
 * finding a specific human, and an id field makes it easy to promote the wrong account with no
 * visible confirmation of who you just picked.
 */
export function TeamPanel() {
  const { data, isLoading } = useTeam();
  const grant = useGrantRole();
  const me = useAuthStore((s) => s.user);
  const [pending, setPending] = useState<UserDTO | null>(null);

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
      </div>
    );
  }

  const canAssign = data.assignableRoles.length > 0;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeading icon={<ShieldCheck className="h-4 w-4" />}>Grant access</SectionHeading>
        {canAssign ? (
          <div className="space-y-3 rounded-xl border border-hairline bg-base-800 p-4">
            <UserSearchInput
              placeholder="Find someone to promote…"
              onSelect={setPending}
              excludeIds={data.team.map((t) => t.id)}
            />

            {pending && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-hairline bg-base-900 p-3">
                <UserAvatar
                  avatarUrl={pending.avatarUrl}
                  name={pending.displayName ?? pending.username}
                  size={36}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-signal">{pending.displayName ?? pending.username}</p>
                  <p className="truncate text-xs text-signal-faint">@{pending.username}</p>
                </div>
                <div className="flex gap-2">
                  {/* Only the roles the SERVER said this caller may assign — an owner sees Staff
                      but not Owner, and nobody ever sees Master. */}
                  {data.assignableRoles
                    .filter((r) => r !== "USER")
                    .map((role) => (
                      <button
                        key={role}
                        type="button"
                        disabled={grant.isPending}
                        onClick={() =>
                          grant.mutate(
                            { userId: pending.id, platformRole: role },
                            { onSuccess: () => setPending(null) },
                          )
                        }
                        className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                      >
                        Make {ROLE_META[role].label}
                      </button>
                    ))}
                  <button
                    type="button"
                    onClick={() => setPending(null)}
                    className="rounded-lg bg-base-600 px-3 py-1.5 text-sm text-signal"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {grant.isError && <p className="text-sm text-flare">{(grant.error as Error).message}</p>}

            <p className="text-xs text-signal-faint">
              Staff get the video review queue. Owners additionally get platform stats, user
              management and bans. Master is set only by <code>MASTER_EMAIL</code> in the server's
              .env and can never be granted from here.
            </p>
          </div>
        ) : (
          <p className="rounded-xl border border-hairline bg-base-800 p-4 text-sm text-signal-dim">
            You don't have permission to change platform roles.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeading icon={<Crown className="h-4 w-4" />}>Current team</SectionHeading>
        <div className="divide-y divide-hairline rounded-xl border border-hairline bg-base-800">
          {data.team.map((member) => {
            const meta = ROLE_META[member.platformRole];
            const Icon = meta.icon;
            const isSelf = member.id === me?.id;
            return (
              <div key={member.id} className="flex flex-wrap items-center gap-3 p-3">
                <UserAvatar
                  avatarUrl={member.avatarUrl}
                  name={member.displayName ?? member.username}
                  size={36}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm text-signal">
                    {member.displayName ?? member.username}
                    <span className={cn("flex items-center gap-1 text-xs", meta.className)}>
                      <Icon className="h-3.5 w-3.5" />
                      {meta.label}
                    </span>
                  </p>
                  <p className="truncate text-xs text-signal-faint">@{member.username} · {member.email}</p>
                  <p className="text-xs text-signal-faint">
                    {member.activity.videosReviewed} videos reviewed · {member.activity.staffActions} actions
                  </p>
                </div>

                {/* The master row has no controls at all: its role comes from env, so any button
                    here would either fail or be silently reverted at their next login. The same
                    applies to a peer — an owner may not change another owner's rank — which is why
                    the control is gated on the server's own assignableRoles rather than on
                    "is not master". */}
                {!isSelf && canAssign && data.assignableRoles.includes(member.platformRole) && (
                  <div className="flex items-center gap-2">
                    {/* A rank change, not just removal: this is how someone moves between Staff and
                        Owner without being demoted to User and re-granted. */}
                    <select
                      aria-label={`Platform role for ${member.username}`}
                      value={member.platformRole}
                      disabled={grant.isPending}
                      onChange={(e) =>
                        grant.mutate({
                          userId: member.id,
                          platformRole: e.target.value as PlatformRole,
                        })
                      }
                      className="rounded-lg border border-hairline bg-base-700 px-2 py-1 text-xs text-signal disabled:opacity-50"
                    >
                      {data.assignableRoles.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_META[role].label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={grant.isPending}
                      onClick={() => grant.mutate({ userId: member.id, platformRole: "USER" })}
                      className="rounded-lg bg-base-600 px-3 py-1.5 text-xs text-signal hover:bg-flare hover:text-white disabled:opacity-50"
                    >
                      Remove access
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-signal-faint">
          Changes here are permanent — they survive the person's next login, and reach their open
          session the next time they focus the window. <code>OWNER_EMAILS</code> /{" "}
          <code>STAFF_EMAILS</code> only act as a bootstrapping floor and never revoke a role.
        </p>
      </section>
    </div>
  );
}

interface PlatformConfig {
  billing: { stripeSecretKey: boolean; stripePublishableKey: boolean; stripeWebhookSecret: boolean; operational: boolean };
  push: { vapidPublicKey: boolean; vapidPrivateKey: boolean };
  voice: { turnSecret: boolean; turnHost: string };
  roles: { masterEmailSet: boolean; ownerCount: number; staffCount: number };
  limits: { maxUploadMb: number; maxVideoUploadMb: number; maxVideoDurationSec: number; maxVideoUploadsPerDay: number };
  environment: string;
}

/** Platform configuration. Shows only whether each secret is present, never its value — a dashboard
 * that renders live credentials leaks them to the first screenshot. */
export function ConfigPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ["master", "config"],
    queryFn: () => api.get<PlatformConfig>("/master/config"),
  });

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeading icon={<ShieldCheck className="h-4 w-4" />}>Integrations</SectionHeading>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ConfigRow label="Stripe billing" ok={data.billing.operational}
            detail={
              data.billing.operational
                ? "Live — payments recorded"
                : data.billing.stripeSecretKey && !data.billing.stripeWebhookSecret
                  ? "Secret key set, webhook secret missing — payments cannot be recorded"
                  : "Not configured"
            } />
          <ConfigRow label="Web push" ok={data.push.vapidPublicKey && data.push.vapidPrivateKey}
            detail={data.push.vapidPublicKey ? "VAPID keys present" : "Not configured"} />
          <ConfigRow label="Voice relay (TURN)" ok={data.voice.turnSecret}
            detail={data.voice.turnSecret ? data.voice.turnHost : "STUN only — restrictive NATs will fail"} />
          <ConfigRow label="Master account" ok={data.roles.masterEmailSet}
            detail={data.roles.masterEmailSet ? "MASTER_EMAIL set" : "Not set"} />
        </div>
        <p className="text-xs text-signal-faint">
          Only presence is shown, never the values. Secrets live in the server's .env.
        </p>
      </section>

      <section className="space-y-3">
        <SectionHeading icon={<FileText className="h-4 w-4" />}>Limits</SectionHeading>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Attachment max" value={`${data.limits.maxUploadMb} MB`} />
          <StatTile label="Video max" value={`${data.limits.maxVideoUploadMb} MB`} />
          <StatTile label="Video duration" value={`${data.limits.maxVideoDurationSec}s`} />
          <StatTile label="Uploads / day" value={data.limits.maxVideoUploadsPerDay} />
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading icon={<Crown className="h-4 w-4" />}>Access</SectionHeading>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatTile label="Owners (env)" value={data.roles.ownerCount} />
          <StatTile label="Staff (env)" value={data.roles.staffCount} />
          <StatTile label="Environment" value={data.environment} />
        </div>
      </section>
    </div>
  );
}

function ConfigRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-hairline bg-base-800 p-3">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-pulse" />
      ) : (
        <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-signal-faint" />
      )}
      <div className="min-w-0">
        <p className="text-sm text-signal">{label}</p>
        <p className="text-xs text-signal-faint">{detail}</p>
      </div>
    </div>
  );
}

interface BrandFile {
  id: string;
  fileName: string;
  uploadedAt: string | null;
  sizeBytes: number;
}

/**
 * Brand kit upload — the master's channel for handing over logos, fonts and palettes for the UI
 * redesign. Files land in the server's uploads volume and are never served publicly.
 */
export function BrandKitPanel() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Array<{ fileName: string; reason: string }>>([]);

  const { data, isLoading } = useQuery({
    queryKey: ["master", "brand-kit"],
    queryFn: () => api.get<{ files: BrandFile[] }>("/master/brand-kit"),
  });

  const upload = useMutation({
    // `File[]`, NOT `FileList`, and that is the entire bug this signature exists to prevent.
    //
    // A FileList is a LIVE view of the input element's selection. The caller below clears the input
    // (`e.target.value = ""`) on the very next line so that re-picking the same file fires another
    // change event — and clearing the input empties the FileList that was just handed over.
    // React Query invokes mutationFn asynchronously, so by the time this ran the list had zero
    // entries: a multipart body with no file parts, a 400 in 20ms, and an upload that looked broken
    // for no visible reason. Taking an array forces the caller to snapshot it synchronously.
    mutationFn: (files: File[]) =>
      new Promise<{ uploaded: unknown[]; rejected: Array<{ fileName: string; reason: string }> }>((resolve, reject) => {
        const form = new FormData();
        for (const file of files) form.append("file", file);
        // XHR rather than fetch: a brand kit can be large and fetch cannot report upload progress,
        // which on a phone connection looks indistinguishable from the app having frozen.
        const xhr = new XMLHttpRequest();
        const base = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";
        xhr.open("POST", `${base}/master/brand-kit`);
        const token = useAuthStore.getState().accessToken;
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
          let body: {
            error?: string;
            uploaded?: unknown[];
            rejected?: Array<{ fileName: string; reason: string }>;
          } = {};
          try {
            body = JSON.parse(xhr.responseText) as typeof body;
          } catch {
            /* non-JSON error */
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve({ uploaded: body.uploaded ?? [], rejected: body.rejected ?? [] });
          } else {
            reject(new Error(body.error ?? "Upload failed"));
          }
        };
        xhr.onerror = () => reject(new Error("Upload failed — check your connection"));
        xhr.send(form);
      }),
    onSuccess: (result) => {
      setProgress(0);
      // A partly-rejected drop is a success for the files that landed and a failure for the rest.
      // Reporting only the first half is how "it uploaded" and "my file isn't there" coexist.
      setRejected(result.rejected);
      void queryClient.invalidateQueries({ queryKey: ["master", "brand-kit"] });
    },
    onError: (err) => {
      setProgress(0);
      setError((err as Error).message);
    },
  });

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeading icon={<Upload className="h-4 w-4" />}>Brand kit</SectionHeading>

        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          // MIME types FIRST, extensions after. Android's file picker filters by MIME and largely
          // ignores bare extensions — an extension-only accept list makes the picker open with
          // everything greyed out, or not open at all, which reads as "file upload is broken".
          // Desktop browsers understand both, so listing both costs nothing there.
          accept={
            "image/*,application/pdf,font/woff,font/woff2,font/ttf,font/otf," +
            "application/zip,text/plain,text/markdown,application/json,*/*," +
            ".png,.jpg,.jpeg,.heic,.heif,.gif,.webp,.avif,.tif,.tiff,.svg,.pdf," +
            ".woff,.woff2,.ttf,.otf,.zip,.txt,.md,.json,.ai,.psd,.sketch,.fig,.xd,.eps"
          }
          onChange={(e) => {
            setError(null);
            setRejected([]);
            // Snapshot BEFORE clearing the input — see the mutationFn comment above.
            const picked = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (picked.length > 0) upload.mutate(picked);
          }}
        />

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={upload.isPending}
          className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-hairline bg-base-800 px-4 py-10 text-signal-dim hover:border-accent hover:text-signal disabled:opacity-50"
        >
          <Upload className="h-7 w-7" />
          <span className="text-sm">Upload brand assets</span>
          <span className="text-xs text-signal-faint">
            Logos, fonts, palettes, style guides · up to 100MB each
          </span>
        </button>

        {upload.isPending && (
          <div className="space-y-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-base-600">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="text-xs text-signal-faint">
              {progress >= 1 ? "Finishing up…" : `Uploading… ${Math.round(progress * 100)}%`}
            </p>
          </div>
        )}
        {rejected.length > 0 && !upload.isPending && (
          <div className="rounded-xl border border-flare/40 bg-flare/10 p-3">
            <p className="mb-1.5 text-sm text-flare">
              {rejected.length} file{rejected.length === 1 ? " was" : "s were"} skipped
            </p>
            <ul className="space-y-1">
              {rejected.map((r) => (
                <li key={r.fileName} className="text-xs text-signal-dim">
                  <span className="break-all text-signal">{r.fileName}</span> — {r.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <p className="text-sm text-flare">{error}</p>}
      </section>

      <section className="space-y-3">
        <SectionHeading icon={<FileText className="h-4 w-4" />}>Uploaded</SectionHeading>
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
        ) : !data || data.files.length === 0 ? (
          <p className="rounded-xl border border-hairline bg-base-800 p-4 text-sm text-signal-dim">
            Nothing uploaded yet.
          </p>
        ) : (
          <div className="divide-y divide-hairline rounded-xl border border-hairline bg-base-800">
            {data.files.map((f) => (
              <div key={f.id} className="flex items-center gap-3 p-3">
                <FileText className="h-4 w-4 shrink-0 text-signal-faint" />
                <span className="min-w-0 flex-1 truncate text-sm text-signal">{f.fileName}</span>
                <span className="shrink-0 text-xs text-signal-faint">{formatBytes(f.sizeBytes)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
