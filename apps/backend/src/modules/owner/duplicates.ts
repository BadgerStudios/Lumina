import { prisma } from "../../db/prisma.js";

/**
 * Accounts that share a device or a network address, grouped so they can be looked at together.
 *
 * The flags raised at signup say "this account is linked to others" and stop there, which is the
 * wrong shape for the decision: what you actually need is both sides in front of you at once —
 * when each was made, whether they look like one person or a household, what else is flagged
 * against them. A flag can tell you to look; only this can tell you what you are looking at.
 *
 * ## The two signals are not equal, and the difference matters more than the grouping
 *
 * A shared DEVICE is strong. The fingerprint is derived from canvas, WebGL, fonts and screen
 * characteristics, so two accounts matching it were almost certainly used on the same machine.
 *
 * A shared IP is weak, and weak in a way that gets people wrongly punished. Home broadband, an
 * office, a school and a café all present one address for everyone behind them, and mobile carriers
 * using CGNAT can put thousands of unrelated customers on a single IP. A pair linked only by
 * address is, on its own, no evidence of anything at all. The strength is reported alongside each
 * group so that distinction survives into whatever gets decided.
 */

export type LinkKind = "device" | "ip";

export interface LinkedAccount {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  platformRole: string;
  isBot: boolean;
  isMinor: boolean;
  ageRecordedAt: string | null;
  ageBracket: string | null;
  /** Unresolved flags on this account, so a linked pair that is ALSO flagged stands out. */
  openFlags: number;
  /** Most recent session, as a proxy for "is this account actually in use". */
  lastSeenAt: string | null;
}

export interface LinkedGroup {
  kind: LinkKind;
  /** Never the fingerprint or address itself — a console that renders those turns a screenshot
   * into a tracking identifier. An opaque key is enough to group and to talk about. */
  key: string;
  accounts: LinkedAccount[];
  /** True when this group is larger than a household plausibly explains. */
  crowded: boolean;
}

/** Beyond this, a group is a carrier or a campus rather than a person with alts. */
const CROWDED_AT = 8;
/** Hard ceiling per group, so one NAT address cannot produce an unreadable page. */
const MAX_PER_GROUP = 25;

interface Row {
  key: string;
  users: string[];
}

async function groupsBy(column: "deviceFingerprint" | "ipAddress"): Promise<Row[]> {
  // Raw because Prisma cannot express "group by X having count(distinct userId) > 1", and doing it
  // in application code would mean pulling every session row on the platform to count them.
  const rows = await prisma.$queryRawUnsafe<{ key: string; users: string[] }[]>(
    `SELECT "${column}" AS key, array_agg(DISTINCT "userId") AS users
       FROM "RefreshToken"
      WHERE "${column}" IS NOT NULL AND "${column}" <> ''
      GROUP BY "${column}"
     HAVING COUNT(DISTINCT "userId") > 1
      ORDER BY COUNT(DISTINCT "userId") DESC
      LIMIT 100`,
  );
  return rows;
}

/** A stable, meaningless handle for a group — enough to identify it in the UI, useless elsewhere. */
function opaqueKey(kind: LinkKind, index: number): string {
  return `${kind}-${index + 1}`;
}

export async function listLinkedAccounts(): Promise<LinkedGroup[]> {
  const [deviceRows, ipRows] = await Promise.all([groupsBy("deviceFingerprint"), groupsBy("ipAddress")]);

  const everyUserId = [...new Set([...deviceRows, ...ipRows].flatMap((r) => r.users))];
  if (everyUserId.length === 0) return [];

  const [users, flagCounts, lastSessions] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: everyUserId } },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        email: true,
        emailVerifiedAt: true,
        createdAt: true,
        platformRole: true,
        isBot: true,
        isMinor: true,
        ageRecordedAt: true,
        ageBracket: true,
      },
    }),
    prisma.accountFlag.groupBy({
      by: ["userId"],
      where: { userId: { in: everyUserId }, resolvedAt: null },
      _count: { _all: true },
    }),
    prisma.refreshToken.groupBy({
      by: ["userId"],
      where: { userId: { in: everyUserId } },
      _max: { createdAt: true },
    }),
  ]);

  const byId = new Map(users.map((u) => [u.id, u]));
  const flagsById = new Map(flagCounts.map((f) => [f.userId, f._count._all]));
  const seenById = new Map(lastSessions.map((s) => [s.userId, s._max.createdAt]));

  const build = (kind: LinkKind, rows: Row[]): LinkedGroup[] =>
    rows.map((row, index) => {
      const accounts = row.users
        .map((id) => byId.get(id))
        .filter((u): u is NonNullable<typeof u> => Boolean(u))
        // Oldest first: the original account is almost always the one to read against.
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, MAX_PER_GROUP)
        .map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          avatarUrl: u.avatarUrl,
          email: u.email,
          emailVerified: u.emailVerifiedAt !== null,
          createdAt: u.createdAt.toISOString(),
          platformRole: u.platformRole,
          isBot: u.isBot,
          isMinor: u.isMinor,
          ageRecordedAt: u.ageRecordedAt?.toISOString() ?? null,
          ageBracket: u.ageBracket,
          openFlags: flagsById.get(u.id) ?? 0,
          lastSeenAt: seenById.get(u.id)?.toISOString() ?? null,
        }));
      return {
        kind,
        key: opaqueKey(kind, index),
        accounts,
        crowded: row.users.length >= CROWDED_AT,
      };
    })
      // A group whose accounts have all been deleted since the session was recorded is not a group.
      .filter((g) => g.accounts.length > 1);

  // Device groups first: they are the ones actually worth a decision.
  return [...build("device", deviceRows), ...build("ip", ipRows)];
}
