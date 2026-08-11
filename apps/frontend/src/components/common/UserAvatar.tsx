import * as Avatar from "@radix-ui/react-avatar";
import type { PresenceStatus } from "@lumina/shared";
import { cn } from "../../lib/cn";
import { resolveAssetUrl } from "../../lib/apiClient";

const presenceColor: Record<PresenceStatus, string> = {
  ONLINE: "bg-online",
  IDLE: "bg-idle",
  DND: "bg-dnd",
  OFFLINE: "bg-offline",
};

export function UserAvatar({
  avatarUrl,
  name,
  size = 32,
  presence,
}: {
  avatarUrl: string | null;
  name: string;
  size?: number;
  presence?: PresenceStatus;
}) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <Avatar.Root
        className="flex items-center justify-center overflow-hidden rounded-full bg-accent text-white select-none"
        style={{ width: size, height: size }}
      >
        {avatarUrl ? (
          <Avatar.Image src={resolveAssetUrl(avatarUrl)} alt={name} className="h-full w-full object-cover" />
        ) : null}
        <Avatar.Fallback
          className="flex h-full w-full items-center justify-center font-semibold"
          style={{ fontSize: Math.max(10, size * 0.4) }}
          delayMs={avatarUrl ? 400 : undefined}
        >
          {initials || "?"}
        </Avatar.Fallback>
      </Avatar.Root>
      {presence ? (
        <span
          className={cn(
            "absolute bottom-0 right-0 rounded-full border-2 border-base-700",
            presenceColor[presence],
          )}
          style={{ width: size * 0.32, height: size * 0.32 }}
          title={presence}
        />
      ) : null}
    </div>
  );
}
