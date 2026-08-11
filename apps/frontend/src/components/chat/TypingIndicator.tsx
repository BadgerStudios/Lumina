import { useEffect, useState } from "react";
import { useTypingStore } from "../../store/typingStore";
import { useMembers } from "../../queries/members";

export function TypingIndicator({ channelId, serverId }: { channelId: string; serverId?: string }) {
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
    return member?.nickname ?? member?.user.displayName ?? member?.user.username ?? "Someone";
  });

  let text: string;
  if (names.length === 1) text = `${names[0]} is typing…`;
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
  else text = `${names.length} people are typing…`;

  return <div className="h-5 px-4 text-xs italic text-signal-dim">{text}</div>;
}
