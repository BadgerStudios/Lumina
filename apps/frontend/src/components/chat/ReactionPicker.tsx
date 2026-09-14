import { useParams } from "react-router-dom";
import { SmilePlus } from "lucide-react";
import { EmojiPicker } from "./EmojiPicker";
import { ICON } from "../common/Icon";

/**
 * The "add a reaction" affordance on a message.
 *
 * The shared searchable picker rather than a fixed grid of twenty, so it can be filtered and
 * includes the space's own custom emoji — resolved from the route's serverId, exactly as
 * MessageItem does when rendering them. A custom emoji is picked as its `:name:` token.
 */
export function ReactionPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const { serverId } = useParams<{ serverId?: string }>();
  return (
    <EmojiPicker
      serverId={serverId}
      onPick={onPick}
      side="top"
      align="start"
      triggerLabel="Add reaction"
      triggerClassName="rounded p-1 text-signal-dim hover:bg-base-500 hover:text-signal"
      icon={<SmilePlus size={ICON.sm} />}
    />
  );
}
