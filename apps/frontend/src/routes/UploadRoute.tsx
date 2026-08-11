import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload, FileText, Loader2, ShieldAlert, CheckCircle2 } from "lucide-react";
import { api } from "../lib/apiClient";
import { useAuthStore } from "../store/authStore";
import { isMaster } from "../lib/platformRole";
import { Login } from "./Login";

interface BrandFile {
  id: string;
  fileName: string;
  uploadedAt: string | null;
  sizeBytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * Standalone file drop at /upload — a plain link that can be opened on any device without
 * navigating the owner console first.
 *
 * Same master-gated endpoint as the console's Brand kit panel, deliberately: one storage location
 * and one permission check, two ways in. Supports drag-and-drop because the usual case is dragging a
 * folder of logos straight from a desktop.
 */
export function UploadRoute() {
  const user = useAuthStore((s) => s.user);
  const status = useAuthStore((s) => s.status);
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [justUploaded, setJustUploaded] = useState(0);

  const { data } = useQuery({
    queryKey: ["master", "brand-kit"],
    queryFn: () => api.get<{ files: BrandFile[] }>("/master/brand-kit"),
    enabled: isMaster(user?.platformRole),
  });

  const upload = useMutation({
    mutationFn: (files: File[]) =>
      new Promise<void>((resolve, reject) => {
        const form = new FormData();
        for (const f of files) form.append("file", f);
        // XHR, not fetch: fetch cannot report upload progress, and a large brand kit with no
        // progress bar is indistinguishable from a frozen page.
        const xhr = new XMLHttpRequest();
        const base = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";
        xhr.open("POST", `${base}/master/brand-kit`);
        const token = useAuthStore.getState().accessToken;
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else {
            let message = "Upload failed";
            try {
              message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? message;
            } catch {
              /* non-JSON body */
            }
            reject(new Error(message));
          }
        };
        xhr.onerror = () => reject(new Error("Upload failed — check your connection"));
        xhr.send(form);
      }),
    onSuccess: (_r, files) => {
      setProgress(0);
      setJustUploaded(files.length);
      void queryClient.invalidateQueries({ queryKey: ["master", "brand-kit"] });
    },
    onError: (err) => {
      setProgress(0);
      setError((err as Error).message);
    },
  });

  const send = (files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setError(null);
    setJustUploaded(0);
    upload.mutate(list);
  };

  if (status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-base-900 text-signal-faint">
        Loading…
      </div>
    );
  }
  if (!user) return <Login />;

  if (!isMaster(user.platformRole)) {
    return (
      <div className="flex h-screen items-center justify-center bg-base-900 p-6">
        <div className="w-full max-w-sm rounded-xl border border-hairline bg-base-800 p-6 text-center">
          <ShieldAlert className="mx-auto mb-3 h-10 w-10 text-flare" />
          <h1 className="font-display text-lg text-signal">Not available</h1>
          <p className="mt-2 text-sm text-signal-dim">
            This upload page is limited to the platform's master account.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-base-900 p-4 text-signal sm:p-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <h1 className="font-display text-2xl">File drop</h1>
          <p className="mt-1 text-sm text-signal-dim">
            Brand kits, logos, fonts, palettes, style guides — anything for the UI work. Up to 100MB
            per file.
          </p>
        </header>

        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          accept=".png,.jpg,.jpeg,.gif,.webp,.svg,.pdf,.woff,.woff2,.ttf,.otf,.zip,.txt,.md,.json,.ai,.psd,.sketch,.fig"
          onChange={(e) => {
            send(e.target.files);
            e.target.value = "";
          }}
        />

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            send(e.dataTransfer.files);
          }}
          className={`rounded-2xl border-2 border-dashed p-10 text-center transition ${
            dragging ? "border-accent bg-base-700" : "border-hairline bg-base-800"
          }`}
        >
          <Upload className="mx-auto mb-3 h-10 w-10 text-signal-faint" />
          <p className="text-signal">Drag files here</p>
          <p className="mt-1 text-sm text-signal-dim">or</p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={upload.isPending}
            className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            Choose files
          </button>
        </div>

        {upload.isPending && (
          <div className="space-y-1">
            <div className="h-2 overflow-hidden rounded-full bg-base-600">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="text-sm text-signal-faint">
              {progress >= 1 ? "Finishing up…" : `Uploading… ${Math.round(progress * 100)}%`}
            </p>
          </div>
        )}

        {justUploaded > 0 && !upload.isPending && (
          <p className="flex items-center gap-2 text-sm text-pulse">
            <CheckCircle2 className="h-4 w-4" />
            {justUploaded} file{justUploaded === 1 ? "" : "s"} uploaded.
          </p>
        )}
        {error && <p className="text-sm text-flare">{error}</p>}

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-signal-dim">
            Uploaded
          </h2>
          {!data || data.files.length === 0 ? (
            <p className="rounded-xl border border-hairline bg-base-800 p-4 text-sm text-signal-dim">
              Nothing uploaded yet.
            </p>
          ) : (
            <div className="divide-y divide-hairline rounded-xl border border-hairline bg-base-800">
              {data.files.map((f) => (
                <div key={f.id} className="flex items-center gap-3 p-3">
                  <FileText className="h-4 w-4 shrink-0 text-signal-faint" />
                  <span className="min-w-0 flex-1 truncate text-sm">{f.fileName}</span>
                  <span className="shrink-0 text-xs text-signal-faint">{formatBytes(f.sizeBytes)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
