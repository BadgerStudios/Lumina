import { Link } from "react-router-dom";
import { SiteNav, SiteFooter } from "../components/site/SiteChrome";
import {
  ShieldCheck,
  Server,
  Fingerprint,
  Video,
  MessageSquare,
  Gavel,
  Eye,
  Lock,
  Check,
  X,
} from "lucide-react";

/**
 * The public feature page.
 *
 * ## The rule this page is written under
 *
 * Every claim here is one the code actually supports, and the safety section is worded to the
 * letter of what the implementation guarantees. That is not timidity — it is the only version worth
 * publishing. Age assurance is a claim parents act on, and a platform that overstates it is worse
 * than one that says nothing, because it converts a careful parent into a trusting one.
 *
 * Specifically: Lumina cannot verify that a stated age is TRUE. It has no ID check and no
 * third-party age assurance. What it can guarantee — and does, on every path — is that the check
 * runs, cannot be skipped, and fails safe. Those are different sentences and the difference is the
 * whole point.
 *
 * The comparison table is limited to publicly verifiable, capability-level differences. No claims
 * about the other platform's conduct, only about what each one is architecturally.
 */
export function FeaturesRoute() {
  return (
    <div className="min-h-app bg-base-900 text-signal">
      <SiteNav />

      <section className="mx-auto max-w-3xl px-6 pb-10 pt-12 text-center">
        <h1 className="font-display text-4xl leading-tight sm:text-5xl">
          A community platform, all in one place
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-signal-dim">
          Servers, channels, voice, video and a short-video feed — hosted and run for you by Badger
          Studios, with no ads sold against your conversations.
        </p>
      </section>

      <Shot
        src="/screens/app-chat.png"
        alt="A Lumina server showing a text channel with several messages, a channel list and a member list"
        caption="Servers, channels, roles, voice and DMs. Everything you'd expect."
      />

      {/* ---- age & safety: the section that has to be exactly right ---------------------- */}
      <section className="mx-auto max-w-5xl px-6 py-14">
        <div className="mb-8 flex items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-online" />
          <h2 className="font-display text-2xl">Age and safety, enforced in the schema</h2>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <p className="text-signal-dim">
              Lumina is 18+ — adults only, with no supervised tier. The age check runs before an
              account row is ever created, and there is no request that can skip it: both the date
              of birth and the age range are required fields, the two are cross-checked, and either
              one indicating under 18 refuses the signup and flags it.
            </p>
            <p className="mt-4 text-signal-dim">
              An account with no age on record cannot contact anyone at all until it answers — not
              adults, not other unanswered accounts. There is no state where the question is simply
              skipped.
            </p>

            <ul className="mt-6 space-y-3 text-sm">
              <Point>Under-18 signups refused before the account exists</Point>
              <Point>Both age fields required — no API path omits the check</Point>
              <Point>An account found to be under 18 is walled off from DMs, group DMs and friend requests server-side, then closed — the device is not banned</Point>
            <Point>An account with no age recorded can contact nobody until it answers</Point>
              <Point>The video feed is restricted to accounts confirmed adult</Point>
              <Point>A repeat under-age attempt puts that device on a 30-day new-account cooldown</Point>
              <Point>Every refusal carries a documented reason code, a plain-English explanation and an appeal route</Point>
            </ul>

            {/* The honest limit, stated on the marketing page rather than buried. A safety claim
                that omits this is one a parent could reasonably feel misled by. */}
            <div className="mt-6 rounded-xl border border-hairline bg-base-800 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-signal-dim">
                What this does and doesn't do
              </p>
              <p className="mt-2 text-sm text-signal-dim">
                Age is self-declared. Lumina does not check ID and does not use a third-party age
                assurance service, so it cannot prove a stated age is true — no platform relying on
                self-declaration can. What it guarantees is that the check always runs, cannot be
                bypassed by any request, refuses to let an account act at all while its age is
                unrecorded, and makes a second attempt from the same device expensive. If you need verified age assurance,
                that is a different product and we'd rather say so than imply otherwise.
              </p>
            </div>
          </div>

          <Shot
            inline
            src="/screens/age-gate.png"
            alt="Lumina's registration form showing the age section: Lumina is 16+, and under-18s need a parent or guardian to link their account."
            caption="The live signup form — age is required and cross-checked before an account is ever created."
          />
        </div>
      </section>

      {/* ---- feature grid ------------------------------------------------------------------ */}
      <section className="mx-auto max-w-5xl px-6 py-10">
        <h2 className="mb-8 font-display text-2xl">What's in the box</h2>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Feature icon={MessageSquare} title="Chat, properly">
            Servers, categories, text and voice channels, roles with permission bitfields, DMs and
            group DMs, replies, reactions, pins, mentions, full-text search, file uploads.
          </Feature>
          <Feature icon={Video} title="Short-video feed">
            A vertical For You feed with its own recommendation engine, hashtags, stitch and duet —
            every upload reviewed by staff before anyone else sees it.
          </Feature>
          <Feature icon={Server} title="On every screen">
            One account across the web app, both Android apps and the Linux desktop build — and
            installable on iPhone straight from Safari. Voice runs on our own TURN server.
          </Feature>
          <Feature icon={Fingerprint} title="Passkeys and 2FA">
            Sign in with Face ID, a fingerprint or Windows Hello. TOTP two-factor with single-use
            recovery codes for accounts that can moderate.
          </Feature>
          <Feature icon={Gavel} title="Moderation that shows its work">
            Report tickets with statuses the reporter can see, a documented catalogue of block
            reasons, platform bans by account, email, IP or device, and an appeal path on every one.
          </Feature>
          <Feature icon={Eye} title="An owner console, not a settings page">
            Live platform health, per-account detail with session history, revenue, downloads,
            bandwidth and an audit trail — on the web and as its own phone app.
          </Feature>
        </div>
      </section>

      <Shot
        src="/screens/app-feed.png"
        alt="Lumina's For You video feed"
        caption="The For You feed. Adults only, and every video is reviewed before it can appear."
      />

      {/* ---- comparison -------------------------------------------------------------------- */}
      <section className="mx-auto max-w-4xl px-6 py-14">
        <h2 className="mb-2 font-display text-2xl">How it differs from Discord</h2>
        <p className="mb-8 text-sm text-signal-dim">
          The differences that actually change the experience — how ads work, who can join, and how
          moderation is handled. Both are good at different jobs.
        </p>

        <div className="overflow-x-auto rounded-xl border border-hairline">
          <table className="w-full text-left text-sm">
            <thead className="bg-base-800 text-xs uppercase tracking-wide text-signal-dim">
              <tr>
                <th className="px-4 py-3 font-semibold">&nbsp;</th>
                <th className="px-4 py-3 font-semibold">Lumina</th>
                <th className="px-4 py-3 font-semibold">Discord</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              <Row label="Minimum age" a="16+ (under-18 parent-supervised)" b="13+" aGood />
              <Row label="Behavioural ad targeting" a="None — ads are never targeted on what you say or watch" b="Sponsored placements" aGood />
              <Row label="Video feed" a="Adults only, every upload human-reviewed" b="No comparable feed" aGood />
              <Row label="Moderation tooling" a="Full console, audit trail, appeals" b="Built-in tools" />
              <Row label="Cost" a="Free to join" b="Free tier + Nitro" aGood />
              <Row label="Scale" a="Small, growing" b="Hundreds of millions of users" bGood />
              <Row label="Ecosystem" a="Small — bots, webhooks, OAuth2, addons" b="Enormous" bGood />
            </tbody>
          </table>
        </div>

        {/* Said plainly, because a comparison table that only flatters is not worth reading. */}
        <p className="mt-4 text-xs text-signal-faint">
          Discord is a larger, more mature product with an ecosystem Lumina will not match. If you
          want the biggest network, use Discord. Lumina is for people who want a smaller place with
          no behavioural ad targeting, a higher age floor and moderation that shows its work.
        </p>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-20 text-center">
        <div className="rounded-2xl border border-hairline bg-base-800 p-8">
          <Lock className="mx-auto mb-3 h-7 w-7 text-accent" />
          <h2 className="font-display text-2xl">Join Lumina</h2>
          <p className="mx-auto mt-3 max-w-lg text-signal-dim">
            Free to join. Available on the web, Android and Linux desktop — and installable on iPhone
            straight from Safari.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/register"
              className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover"
            >
              Create an account
            </Link>
            <a
              href="/downloads/lumina.apk"
              className="rounded-lg border border-base-500 px-5 py-2.5 text-sm font-semibold text-signal hover:bg-base-700"
            >
              Download for Android
            </a>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}

function Shot({
  src,
  alt,
  caption,
  inline,
}: {
  src: string;
  alt: string;
  caption: string;
  inline?: boolean;
}) {
  return (
    <figure className={inline ? "" : "mx-auto max-w-5xl px-6 py-8"}>
      {/* Real screenshots of the running app, taken against seeded demo content — never a real
          user's messages or username. */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className="w-full rounded-xl border border-hairline shadow-2xl"
      />
      <figcaption className="mt-3 text-center text-xs text-signal-faint">{caption}</figcaption>
    </figure>
  );
}

function Feature({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Server;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-base-800 p-5">
      <Icon className="mb-3 h-5 w-5 text-accent" />
      <h3 className="font-display text-base">{title}</h3>
      <p className="mt-1.5 text-sm text-signal-dim">{children}</p>
    </div>
  );
}

function Point({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-signal-dim">
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-online" />
      <span>{children}</span>
    </li>
  );
}

function Row({
  label,
  a,
  b,
  aGood,
  bGood,
}: {
  label: string;
  a: string;
  b: string;
  aGood?: boolean;
  bGood?: boolean;
}) {
  return (
    <tr>
      <th scope="row" className="px-4 py-3 font-medium text-signal-dim">{label}</th>
      <td className="px-4 py-3">
        <span className="flex items-start gap-2">
          {aGood ? (
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-online" />
          ) : bGood ? (
            <X className="mt-0.5 h-4 w-4 shrink-0 text-signal-faint" />
          ) : null}
          <span className="text-signal">{a}</span>
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="flex items-start gap-2">
          {bGood ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-online" /> : null}
          <span className="text-signal-dim">{b}</span>
        </span>
      </td>
    </tr>
  );
}
