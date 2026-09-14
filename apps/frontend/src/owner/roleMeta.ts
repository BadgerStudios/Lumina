import { Crown, Gavel, Briefcase, ShieldCheck, User as UserIcon } from "lucide-react";
import type { PlatformRole } from "@lumina/shared";

/**
 * How each rank is named and drawn, in one place.
 *
 * The Users list and the Team panel each had their own copy of this, which is why one of them said
 * "Staff" while the other drew a shield and neither knew about a rank the other had. A `Record` keyed
 * by the role also means adding a rung to the ladder fails to compile until every surface names it,
 * rather than rendering `undefined` somewhere nobody looked.
 *
 * The colours run blue → violet → purple with seniority, so the ladder is legible at a glance
 * without reading the labels; gold is kept apart for the master account, which is not a rung on the
 * same ladder but the one role no API can grant.
 */
export const ROLE_META: Record<PlatformRole, { label: string; icon: typeof Crown; className: string; tone?: "master" | "owner" | "executive" | "admin" | "staff" }> = {
  MASTER: { label: "Master", icon: Crown, className: "text-[var(--oc-master)]", tone: "master" },
  OWNER: { label: "Owner", icon: Crown, className: "text-[var(--oc-owner)]", tone: "owner" },
  EXECUTIVE: { label: "Executive", icon: Briefcase, className: "text-[var(--oc-executive)]", tone: "executive" },
  ADMIN: { label: "Admin", icon: Gavel, className: "text-[var(--oc-admin)]", tone: "admin" },
  MODERATOR: { label: "Moderator", icon: ShieldCheck, className: "text-[var(--oc-staff)]", tone: "staff" },
  USER: { label: "User", icon: UserIcon, className: "text-signal-faint" },
};

/** What each rung actually gets, for the Team panel to explain rather than leave people guessing. */
export const ROLE_DUTIES: Record<Exclude<PlatformRole, "USER">, string> = {
  MODERATOR: "Video review, reports, age reviews and block reasons.",
  ADMIN: "Everything a moderator has, plus the user directory, bans, appeals and linked accounts.",
  EXECUTIVE: "Everything an admin has, plus revenue, engagement, downloads and the message of the day.",
  OWNER: "Everything, plus system and infrastructure — and the only rank that can change who holds one.",
  MASTER: "Set solely by MASTER_EMAIL in the server's .env, and never grantable from here.",
};
