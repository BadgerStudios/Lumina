import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "./Modal";
import { useUIStore } from "../../store/uiStore";
import { useCreateServer } from "../../queries/servers";
import { useApplyTemplate, useMyTemplates, useTemplate } from "../../queries/templates";
import { cn } from "../../lib/cn";

type Mode = "blank" | "template";

export function CreateServerModal() {
  const openModal = useUIStore((s) => s.openModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  const createServer = useCreateServer();
  const applyTemplate = useApplyTemplate();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<Mode>("blank");
  const [code, setCode] = useState("");

  const open = openModal === "createServer";
  const { data: myTemplates } = useMyTemplates();
  // Only looked up once the code is long enough to plausibly be one, so every keystroke of a paste
  // does not become a request that 404s.
  const { data: preview, isError: previewFailed } = useTemplate(open && mode === "template" ? code.trim() : undefined);

  function finish(server: { id: string; systemChannelId: string | null }) {
    setName("");
    setCode("");
    setMode("blank");
    closeModal();
    closeMobileDrawer();
    if (server.systemChannelId) navigate(`/channels/${server.id}/${server.systemChannelId}`);
    else navigate(`/channels/${server.id}/_`);
  }

  async function handleCreate() {
    if (!name.trim()) return;
    if (mode === "template") {
      if (!code.trim()) return;
      finish(await applyTemplate.mutateAsync({ code: code.trim(), name: name.trim() }));
      return;
    }
    finish(await createServer.mutateAsync({ name: name.trim() }));
  }

  const busy = createServer.isPending || applyTemplate.isPending;
  const ready = name.trim().length > 0 && (mode === "blank" || (code.trim().length > 0 && !!preview));

  return (
    <Modal open={open} onOpenChange={(o) => !o && closeModal()} title="Create a Server">
      <div className="mb-4 flex gap-1 rounded-lg bg-base-900 p-1">
        {(["blank", "template"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              "flex-1 rounded px-3 py-1.5 text-sm font-medium transition",
              mode === m ? "bg-base-600 text-signal" : "text-signal-dim hover:text-signal",
            )}
          >
            {m === "blank" ? "Start fresh" : "From a template"}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-bold uppercase text-signal-dim">Server name</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleCreate()}
          className="rounded bg-base-900 px-3 py-2.5 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
          placeholder="My awesome server"
        />
      </label>

      {mode === "template" ? (
        <div className="mt-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase text-signal-dim">Template code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.trim())}
              className="rounded bg-base-900 px-3 py-2.5 font-mono text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
              placeholder="Paste a template code"
            />
          </label>

          {myTemplates && myTemplates.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="py-1 text-xs text-signal-faint">Yours:</span>
              {myTemplates.map((t) => (
                <button
                  key={t.code}
                  onClick={() => setCode(t.code)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs",
                    code === t.code ? "border-accent text-accent" : "border-base-500 text-signal-dim hover:text-signal",
                  )}
                >
                  {t.name}
                </button>
              ))}
            </div>
          ) : null}

          {code.trim().length > 0 && previewFailed ? (
            <p className="mt-2 text-xs text-dnd">No template with that code.</p>
          ) : null}

          {preview ? (
            <div className="mt-3 rounded-lg border border-base-500 bg-base-900/60 p-3">
              <p className="text-sm font-semibold text-signal">{preview.name}</p>
              {preview.description ? <p className="mt-0.5 text-xs text-signal-dim">{preview.description}</p> : null}
              <p className="mt-1.5 text-xs text-signal-faint">
                {preview.summary.categories} categories · {preview.summary.textChannels} text ·{" "}
                {preview.summary.voiceChannels} voice · {preview.summary.roles} roles
              </p>
              {/* Said plainly because it is the one way an applied template differs from its source,
                  and someone would otherwise find out by wondering where their admin role went. */}
              <p className="mt-1.5 text-[11px] text-signal-faint">
                Roles come across without Administrator or Manage Server — you can grant those yourself
                afterwards.
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-sm text-signal-dim">
          You&apos;ll get a general text channel and three voice channels to start with.
        </p>
      )}

      <div className="mt-5 flex justify-end gap-3">
        <button onClick={closeModal} className="rounded px-4 py-2 text-sm font-medium text-signal-dim hover:underline">
          Cancel
        </button>
        <button
          onClick={() => void handleCreate()}
          disabled={!ready || busy}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </Modal>
  );
}
