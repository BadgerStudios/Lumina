import { APP_HOME } from "../../lib/platform";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Plus, MessageSquare, Clapperboard, ShieldCheck, Crown } from "lucide-react";
import { useAuthStore } from "../../store/authStore";
import { isStaff as checkStaff, isOwner as checkOwner } from "../../lib/platformRole";
import { useServers } from "../../queries/servers";
import { useChannels } from "../../queries/channels";
import { useUIStore } from "../../store/uiStore";
import { resolveAssetUrl } from "../../lib/apiClient";
import { cn } from "../../lib/cn";

function ServerIcon({ id, name, iconUrl, active }: { id: string; name: string; iconUrl: string | null; active: boolean }) {
  const navigate = useNavigate();
  const { data: channels } = useChannels(id);
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);

  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  function handleClick() {
    if (channels && channels.length > 0) {
      const first = [...channels].filter((c) => c.type === "TEXT").sort((a, b) => a.position - b.position)[0];
      navigate(`/channels/${id}/${first?.id ?? channels[0].id}`);
    } else {
      navigate(`/channels/${id}/_`);
    }
    closeMobileDrawer();
  }

  return (
    <button
      onClick={handleClick}
      title={name}
      className={cn(
        "group relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden transition-all",
        active ? "rounded-2xl bg-grad text-white" : "rounded-3xl bg-base-600 text-signal hover:rounded-2xl hover:bg-grad hover:text-white",
      )}
    >
      <span
        className={cn(
          "absolute -left-1.5 h-2 w-1 rounded-r-full bg-signal transition-all",
          active ? "h-9" : "h-0 group-hover:h-4",
        )}
      />
      {iconUrl ? <img src={resolveAssetUrl(iconUrl)} alt={name} className="h-full w-full object-cover" /> : <span className="font-display text-sm font-bold">{initials}</span>}
    </button>
  );
}

export function ServerRail() {
  const { data: servers } = useServers();
  const { serverId } = useParams();
  const { pathname } = useLocation();
  // The role only decides whether the entry is rendered — the API enforces the real check.
  const platformRole = useAuthStore((s) => s.user?.platformRole);
  // Rank comparison, never equality — MASTER is above OWNER and would fail an === check, hiding
  // both the staff and owner entries from the one account that should always see them.
  const isStaff = checkStaff(platformRole);
  const isOwner = checkOwner(platformRole);
  const canUseFeed = useAuthStore((s) => s.user?.ageVerified === true && s.user?.isMinor === false);
  const onFeed = pathname.startsWith("/foryou");
  const onStaff = pathname.startsWith("/staff");
  const onOwner = pathname.startsWith("/owner");
  const openModalWith = useUIStore((s) => s.openModalWith);
  const mobileDrawer = useUIStore((s) => s.mobileDrawer);
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  const isMobileOpen = mobileDrawer === "servers";

  return (
    <>
      {isMobileOpen && (
        <div className="mobile-drawer-backdrop fixed inset-0 z-30 md:hidden" onClick={closeMobileDrawer} />
      )}
      <div
        className={cn(
          "h-full w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-base-900 py-3 md:flex",
          isMobileOpen ? "fixed inset-y-0 left-0 z-40 flex shadow-2xl" : "hidden",
        )}
      >
        <Link
          to={APP_HOME}
          title="Direct Messages"
          onClick={closeMobileDrawer}
          className={cn(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-3xl bg-base-600 text-signal transition-all hover:rounded-2xl hover:bg-grad hover:text-white",
            // `!serverId` alone would also match /foryou and /staff, lighting up two rail entries
            // at once — those routes carry no :serverId param either.
            !serverId && !onFeed && !onStaff && !onOwner && "rounded-2xl bg-grad text-white",
          )}
        >
          <MessageSquare size={22} />
        </Link>

        {canUseFeed && (
        <Link
          to="/foryou"
          title="For You"
          onClick={closeMobileDrawer}
          className={cn(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-3xl bg-base-600 text-signal transition-all hover:rounded-2xl hover:bg-grad hover:text-white",
            onFeed && "rounded-2xl bg-grad text-white",
          )}
        >
          <Clapperboard size={22} />
        </Link>
        )}

        {isStaff && (
          <Link
            to="/staff/videos"
            title="Video review (staff)"
            onClick={closeMobileDrawer}
            className={cn(
              "flex h-12 w-12 shrink-0 items-center justify-center rounded-3xl bg-base-600 text-amber transition-all hover:rounded-2xl hover:bg-grad hover:text-white",
              onStaff && "rounded-2xl bg-grad text-white",
            )}
          >
            <ShieldCheck size={22} />
          </Link>
        )}

        {isOwner && (
          <Link
            to="/owner"
            title="Owner dashboard"
            onClick={closeMobileDrawer}
            className={cn(
              "flex h-12 w-12 shrink-0 items-center justify-center rounded-3xl bg-base-600 text-amber transition-all hover:rounded-2xl hover:bg-grad hover:text-white",
              onOwner && "rounded-2xl bg-grad text-white",
            )}
          >
            <Crown size={22} />
          </Link>
        )}

        <div className="my-1 h-px w-8 bg-base-600" />

        {servers?.map((s) => (
          <ServerIcon key={s.id} id={s.id} name={s.name} iconUrl={s.iconUrl} active={s.id === serverId} />
        ))}

        <button
          onClick={() => openModalWith("createServer")}
          title="Add a Server"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-3xl bg-base-600 text-online transition-all hover:rounded-2xl hover:bg-online hover:text-white"
        >
          <Plus size={22} />
        </button>
      </div>
    </>
  );
}
