import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useChannels } from "../queries/channels";

/** Handles /channels/:serverId with no channel segment (e.g. right after accepting an
 * invite) by redirecting to the server's first text channel once it's loaded. */
export function ServerRedirect() {
  const { serverId } = useParams<{ serverId: string }>();
  const { data: channels } = useChannels(serverId);
  const navigate = useNavigate();

  useEffect(() => {
    if (!serverId || !channels || channels.length === 0) return;
    const firstText = [...channels].filter((c) => c.type === "TEXT").sort((a, b) => a.position - b.position)[0];
    if (firstText) navigate(`/channels/${serverId}/${firstText.id}`, { replace: true });
  }, [serverId, channels, navigate]);

  return <div className="flex flex-1 items-center justify-center text-signal-faint">Loading server…</div>;
}
