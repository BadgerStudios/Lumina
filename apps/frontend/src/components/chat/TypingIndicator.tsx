import { useEffect, useState } from "react";
import { useTypingStore } from "../../store/typingStore";
import { useMembers } from "../../queries/members";
import type { UserDTO } from "@lumina/shared";

export function TypingIndicator({
  channelId,
  serverId,
  // A DM has no member list to look a nickname up in, and without this every DM would have
  // read "Someone is typing…" — in a two-person conversation, the least useful sentence there is.
  participants,
}: {
  channelId: string;
  serverId?: string;
  participants?: UserDTO[];
}) {
  const typingByChannel = useTypingStore((s) => s.typingByChannel);
  const pruneExpired = useTypingStore((s) => s.pruneExpired);
  const { data: members } = useMembers(serverId);

  useEffect(() => {
    const interval = setInterval(() => pruneExpired(channelId), 2000);
    return () => clearInterval(interval);
  }, [channelId, pruneExpired]);

  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1500);
    return () => clearInterval(t);
  }, []);

  const entries = Object.keys(typingByChannel[channelId] ?? {});
  if (entries.length === 0) return <div className="h-5" />;

  const names = entries.map((userId) => {
    const member = members?.find((m) => m.userId === userId);
    if (member) return member.nickname ?? member.user.displayName ?? member.user.username;
    const participant = participants?.find((p) => p.id === userId);
    return participant?.displayName ?? participant?.username ?? "Someone";
  });

  let text: string;
  if (names.length === 1) text = `${names[0]} is typing…`;
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
  else text = `${names.length} people are typing…`;

  return <div className="h-5 px-4 text-xs italic text-signal-dim">{text}</div>;
}
