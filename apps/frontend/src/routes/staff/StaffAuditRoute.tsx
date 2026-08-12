import { Loader2 } from "lucide-react";
import { useStaffAudit } from "../../queries/staff";
import { UserAvatar } from "../../components/common/UserAvatar";

/**
 * The staff audit log — every moderation action, append-only.
 *
 * Lifted out of the video queue's tab strip and given its own section of the suite. It was never a
 * video *status*, so sitting alongside Pending/Approved/Rejected made it read like one; and it
 * records ad decisions and takedowns too, not only video review.
 */
export function StaffAuditRoute() {
  const { data: entries, isLoading } = useStaffAudit();

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
      </div>
    );
  }
  if (!entries || entries.length === 0) {
    return <p className="py-10 text-center text-signal-dim">No staff actions recorded yet.</p>;
  }

  return (
    <div className="mx-auto max-w-3xl divide-y divide-hairline rounded-lg border border-hairline bg-base-800">
      {entries.map((e) => (
        <div key={e.id} className="flex items-start gap-3 p-3">
          <UserAvatar
            avatarUrl={e.actor?.avatarUrl ?? null}
            name={e.actor?.displayName ?? e.actor?.username ?? "?"}
            size={28}
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-signal">
              <span className="font-medium">
                {e.actor?.displayName ?? e.actor?.username ?? "[deleted user]"}
              </span>{" "}
              <span className="text-signal-dim">{e.actionType.replace(/_/g, " ").toLowerCase()}</span>{" "}
              <span className="text-signal-faint">video {e.targetId}</span>
            </p>
            {e.reason && <p className="text-xs text-signal-dim">"{e.reason}"</p>}
          </div>
          <span className="shrink-0 text-xs text-signal-faint">
            {new Date(e.createdAt).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}
