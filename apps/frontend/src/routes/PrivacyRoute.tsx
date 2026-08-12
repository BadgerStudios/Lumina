import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";

/**
 * Privacy policy.
 *
 * Written to describe what this system ACTUALLY does — the fields collected, where they go, who can
 * see them, and how long they last — because a policy that doesn't match the implementation is
 * worse than none: it is a documented promise you are visibly not keeping.
 *
 * It is not legal advice and has not been reviewed by a lawyer. Before this instance takes real
 * users at scale, someone qualified in the jurisdictions it operates in should read it.
 */
export function PrivacyRoute() {
  return (
    <div className="min-h-app bg-base-900 px-4 py-10 text-signal">
      <article className="mx-auto max-w-2xl space-y-8">
        <header>
          <Link to="/" className="text-sm text-accent hover:underline">
            ← Back to Lumina
          </Link>
          <h1 className="mt-4 font-display text-3xl">Privacy Policy</h1>
          <p className="mt-2 text-sm text-signal-faint">Last updated 9 August 2026</p>
        </header>

        <section className="rounded-xl border border-accent/40 bg-base-800 p-5">
          <h2 className="flex items-center gap-2 font-display text-lg">
            <ShieldCheck className="h-5 w-5 text-accent" />
            Protecting children comes first
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-signal-dim">
            Nothing on this platform takes priority over the safety of young people. Where protecting
            a child conflicts with any other goal we have — growth, engagement, revenue, someone's
            convenience, or our own — the child's safety wins. That is not a marketing line; it is
            the rule we resolve decisions by, and the rest of this policy follows from it.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-signal-dim">
            <strong className="text-signal">Lumina is for people aged 18 and over.</strong> We ask
            for your age range and date of birth when you create an account so we can enforce that.
            If either answer indicates you are under 18, we do not create the account, and new
            accounts cannot be created from that device for a short period afterwards.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-signal-dim">
            If you believe a child is using this platform, or that a child is at risk here, contact
            us immediately. We will act on that before anything else in our queue.
          </p>
        </section>

        <Section title="What we collect">
          <Item label="Account details">
            Username, display name, email address, and a password (stored only as a hash — we cannot
            read it, and neither can anyone who obtains our database).
          </Item>
          <Item label="Age">
            An age range and your date of birth, collected once at signup. Your date of birth is
            never shown on your profile or to other users.
          </Item>
          <Item label="Content you create">
            Messages, uploaded files, videos, comments, and reactions.
          </Item>
          <Item label="Device and connection information">
            IP address, browser user-agent, and a device fingerprint derived from your browser's
            characteristics. We use these to keep sessions working, to enforce bans, and to stop
            banned users returning immediately under a new account.
          </Item>
          <Item label="Profile details you choose to add">
            Avatar, banner, bio, pronouns, and status — all optional.
          </Item>
        </Section>

        <Section title="What we do with it">
          <p className="text-sm leading-relaxed text-signal-dim">
            We use this information to run the service: to sign you in, deliver your messages, show
            you the right content, enforce our rules, and keep the platform working. We do not sell
            it, and we do not share it with advertisers.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-signal-dim">
            Age information is used for exactly one purpose: determining whether an account is
            eligible for the platform, and keeping accounts of different age groups from contacting
            each other where that applies. It is not used for advertising or recommendations.
          </p>
        </Section>

        <Section title="How identifiers are stored">
          <p className="text-sm leading-relaxed text-signal-dim">
            When an email address, IP address, or device fingerprint is recorded against a ban or a
            safety flag, we store a one-way hash of it rather than the value itself. That is enough
            to recognise the same identifier again, and not enough to recover the original from our
            records. Our own staff console never displays these values.
          </p>
        </Section>

        <Section title="Who can see what">
          <Item label="Other users">
            Your profile, and whatever you post where they can see it. Never your email address, date
            of birth, IP address, or device information.
          </Item>
          <Item label="Moderators">
            Content that is reported or awaiting review, and the moderation history attached to it.
          </Item>
          <Item label="Platform administrators">
            Account details including email addresses, and session metadata, where needed to
            administer the platform or investigate abuse. Every administrative action is logged.
          </Item>
        </Section>

        <Section title="Your choices">
          <Item label="Export your data">
            You can download everything we hold about your account at any time, from Settings.
          </Item>
          <Item label="Delete your account">
            You can delete your account from Settings. This removes your account and its personal
            details.
          </Item>
          <Item label="Control who can reach you">
            Settings lets you limit direct messages and friend requests.
          </Item>
          <Item label="Appeal a ban">
            Every ban carries a reference and an appeal route. Bans that match on IP or device can
            catch the wrong person, and appeals exist precisely because of that.
          </Item>
        </Section>

        <Section title="How long we keep things">
          <p className="text-sm leading-relaxed text-signal-dim">
            Account data is kept while the account exists. Safety records — bans, appeals, and
            moderation decisions — are kept after an account is deleted, because a record that
            disappears with the account it concerns provides no protection to anyone. Device signup
            cooldowns expire automatically.
          </p>
        </Section>

        <Section title="Contact">
          <p className="text-sm leading-relaxed text-signal-dim">
            For privacy questions, data requests, or to report a child-safety concern, contact the
            platform administrator. Child-safety reports are handled ahead of everything else.
          </p>
        </Section>

        {/* Said plainly rather than buried. A policy presented as finished when it has had no legal
            review invites exactly the false confidence it should be preventing. */}
        <footer className="rounded-xl border border-hairline bg-base-800 p-4">
          <p className="text-xs leading-relaxed text-signal-faint">
            This policy describes how the software actually behaves today. It has not been reviewed
            by a lawyer. Before operating at scale, or in jurisdictions with specific requirements
            (GDPR, COPPA, the UK Age Appropriate Design Code, and similar), it should be reviewed by
            someone qualified in those jurisdictions.
          </p>
        </footer>
      </article>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 font-display text-lg">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="text-sm leading-relaxed text-signal-dim">
      <strong className="text-signal">{label}.</strong> {children}
    </p>
  );
}
