import { useState } from "react";
import { Gamepad2, Circle, Copy, Check, Play, Square, RotateCw, Users } from "lucide-react";
import { Modal } from "./Modal";
import { cn } from "../../lib/cn";
import { useUIStore } from "../../store/uiStore";
import { useServerSandboxes, useSandboxCommand, type ServerSandboxDTO } from "../../queries/sandbox";

/**
 * The in-server Game Activity panel. A container running on the owner's machine (via the Lumina
 * Game Agent) streams its live state into here: status, player count, connect address, and a
 * rolling console tail — refreshed every few seconds. The owner additionally gets start/stop/
 * restart controls; members see it read-only.
 *
 * This is where a video stream would later dock (the agent publishing gameplay into the channel's
 * voice room via Go Live) — the panel is the surface, the data stream is live today.
 */
export function GameModal() {
  const openModal = useUIStore((s) => s.openModal);
  const payload = useUIStore((s) => s.modalPayload) as { serverId: string } | undefined;
  const close = useUIStore((s) => s.closeModal);
  const open = openModal === "game" && !!payload;
  const serverId = payload?.serverId ?? "";
  const { data: sandboxes } = useServerSandboxes(open ? serverId : undefined);

  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Games" width="max-w-2xl">
      <div className="flex flex-col gap-3">
        {!sandboxes?.length ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Gamepad2 size={30} className="text-signal-faint" />
            <p className="text-sm text-signal-faint">No game is connected to this server yet.</p>
            <p className="max-w-sm text-xs text-signal-faint">
              Run the Lumina Game Agent on your machine and attach its sandbox to this server, and the
              live server streams in here.
            </p>
          </div>
        ) : (
          sandboxes.map((sb) => <GameCard key={sb.id} sb={sb} serverId={serverId} />)
        )}
      </div>
    </Modal>
  );
}

function GameCard({ sb, serverId }: { sb: ServerSandboxDTO; serverId: string }) {
  const command = useSandboxCommand(serverId);
  const [copied, setCopied] = useState(false);
  const statusColor =
    sb.status === "ONLINE" ? "text-online" : sb.status === "ERROR" ? "text-dnd" : sb.status === "OFFLINE" ? "text-signal-faint" : "text-accent";

  return (
    <div className="rounded-xl bg-base-900 p-4 ring-1 ring-base-600">
      <div className="flex items-center gap-2.5">
        <Gamepad2 size={18} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-signal">{sb.name}</p>
          <p className="flex items-center gap-1.5 text-xs text-signal-faint">
            <Circle size={7} className={cn("fill-current", statusColor)} />
            <span className={statusColor}>{sb.status}</span>
            {sb.online && (
              <span className="flex items-center gap-1">
                · <Users size={11} /> {sb.playerCount}/{sb.maxPlayers}
              </span>
            )}
          </p>
        </div>
        {sb.isOwner && (
          <div className="flex shrink-0 items-center gap-1">
            <button onClick={() => command.mutate({ id: sb.id, command: "start" })} title="Start" className="rounded p-1.5 text-signal-dim hover:bg-base-700 hover:text-online">
              <Play size={15} />
            </button>
            <button onClick={() => command.mutate({ id: sb.id, command: "restart" })} title="Restart" className="rounded p-1.5 text-signal-dim hover:bg-base-700 hover:text-accent">
              <RotateCw size={15} />
            </button>
            <button onClick={() => command.mutate({ id: sb.id, command: "stop" })} title="Stop" className="rounded p-1.5 text-signal-dim hover:bg-base-700 hover:text-dnd">
              <Square size={15} />
            </button>
          </div>
        )}
      </div>

      {sb.online && sb.connectAddress && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-base-800 px-3 py-2">
          <span className="text-[11px] font-bold uppercase text-signal-dim">Connect</span>
          <code className="min-w-0 flex-1 truncate text-sm text-signal">{sb.connectAddress}</code>
          <button
            onClick={() => { void navigator.clipboard.writeText(sb.connectAddress!); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            className="shrink-0 rounded p-1 text-signal-faint hover:text-signal"
            title="Copy address"
          >
            {copied ? <Check size={14} className="text-online" /> : <Copy size={14} />}
          </button>
        </div>
      )}

      {/* The container's live console streaming into the channel. */}
      {sb.online && sb.consoleTail && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] font-bold uppercase text-signal-dim">Live console</p>
          <pre className="max-h-48 overflow-auto rounded-lg bg-base-950 p-2.5 text-[11px] leading-snug text-signal-dim ring-1 ring-base-600">
            {sb.consoleTail}
          </pre>
        </div>
      )}
    </div>
  );
}
