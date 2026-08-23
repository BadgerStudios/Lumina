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

interface UploadResult {
  uploaded: Array<{ id: string; fileName: string; sizeBytes: number }>;
  rejected?: Array<{ fileName: string; reason: string }>;
}

/**
 * MIME types first, extensions after, and a wildcard entry present.
 *
 * Android's picker filters on MIME and largely ignores bare extensions: an extension-only list
 * greys out every file, which reads as a broken upload. iOS applies its own interpretation and will
 * hide a `.heic` straight from the camera roll unless the list is permissive. The server decides
 * what is actually acceptable — this attribute is a convenience hint, and a hint that hides the
 * user's own files is worse than no hint.
 */
const ACCEPT_HINT =
  "image/*,application/pdf,font/woff,font/woff2,font/ttf,font/otf," +
  "application/zip,text/plain,text/markdown,application/json,*/*," +
  ".png,.jpg,.jpeg,.heic,.heif,.gif,.webp,.avif,.tif,.tiff,.svg,.pdf," +
  ".woff,.woff2,.ttf,.otf,.zip,.txt,.md,.json,.ai,.psd,.sketch,.fig,.xd,.eps";

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
  const [rejected, setRejected] = useState<Array<{ fileName: string; reason: string }>>([]);

  const { data } = useQuery({
    queryKey: ["master", "brand-kit"],
    queryFn: () => api.get<{ files: BrandFile[] }>("/master/brand-kit"),
    enabled: isMaster(user?.platformRole),
  });

  const upload = useMutation({
    mutationFn: (files: File[]) =>
      new Promise<UploadResult>((resolve, reject) => {
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
          let body: Partial<UploadResult> & { error?: string } = {};
          try {
            body = JSON.parse(xhr.responseText) as typeof body;
          } catch {
            /* non-JSON body */
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
    // Counted from what the SERVER says it stored, not from how many files were picked. The two
    // differ whenever a file is refused, and reporting the picked count would claim a success that
    // did not happen.
    onSuccess: (result) => {
      setProgress(0);
      setJustUploaded(result.uploaded.length);
      setRejected(result.rejected ?? []);
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
    setRejected([]);
    upload.mutate(list);
  };

  if (status === "loading") {
    return (
      <div className="flex h-app items-center justify-center bg-base-900 text-signal-faint">
        Loading…
      </div>
    );
  }
  if (!user) return <Login />;

  if (!isMaster(user.platformRole)) {
    return (
      <div className="flex h-app items-center justify-center bg-base-900 p-6">
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
    <div className="min-h-app bg-base-900 p-4 text-signal sm:p-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <h1 className="font-display text-2xl">File drop</h1>
          <p className="mt-1 text-sm text-signal-dim">
            Brand kits, logos, fonts, palettes, style guides — anything for the UI work. Up to 1GB
            per file.
          </p>
        </header>

        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          accept={ACCEPT_HINT}
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
        {rejected.length > 0 && !upload.isPending && (
          <div className="rounded-xl border border-flare/40 bg-flare/10 p-3">
            <p className="mb-1.5 flex items-center gap-2 text-sm text-flare">
              <ShieldAlert className="h-4 w-4 shrink-0" />
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
