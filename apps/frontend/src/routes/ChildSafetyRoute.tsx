import { Link } from "react-router-dom";
import { ShieldAlert } from "lucide-react";

/**
 * Published standards against child sexual abuse and exploitation (CSAE).
 *
 * Google Play requires apps with social or user-generated-content features to publish these
 * standards at a public URL and link to that URL in Play Console. This page is that URL.
 *
 * Written to describe the controls this system ACTUALLY has — pre-publication human review,
 * verified age with minor/adult separation enforced server-side, reporting with visible outcomes.
 * A published standard that overstates what the product does is worse than none: it is a specific,
 * documented commitment that can be shown not to have been kept.
 *
 * Not legal advice and not reviewed by a lawyer. Before this instance takes users at scale, someone
 * qualified should read it — particularly the reporting obligations, which vary by jurisdiction.
 */
export function ChildSafetyRoute() {
  return (
    <div className="min-h-app bg-base-900 px-4 py-10 text-signal">
      <article className="mx-auto max-w-2xl space-y-8">
        <header>
          <Link to="/" className="text-sm text-accent hover:underline">
            ← Back to Lumina
          </Link>
          <h1 className="mt-4 font-display text-3xl">Child Safety Standards</h1>
          <p className="mt-2 text-sm text-signal-faint">
            Our standards against child sexual abuse and exploitation (CSAE) · Last updated 21 August 2026
          </p>
        </header>

        <section className="rounded-xl border border-accent/40 bg-base-800 p-5">
          <h2 className="flex items-center gap-2 font-display text-lg">
            <ShieldAlert className="h-5 w-5 text-accent" />
            Zero tolerance
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-signal-dim">
            Lumina prohibits child sexual abuse and exploitation in every form, without exception and
            without warning. There is no context in which this material or conduct is permitted here,
            and no appeal that reverses it. Accounts involved are removed permanently and reported to
            the relevant authorities — not merely moderated.
          </p>
        </section>

        <Section title="What is prohibited">
          <Item label="Child sexual abuse material (CSAM)">
            Any image, video, drawing, generated image or text depicting the sexual abuse or sexual
            exploitation of a minor. Synthetic, AI-generated and animated depictions are treated
            identically to photographic ones.
          </Item>
          <Item label="Sexualisation of minors">
            Content that presents a minor in a sexualised way, including material that is not itself
            explicit — suggestive posing, sexualised commentary about a minor, or collections
            assembled for that purpose.
          </Item>
          <Item label="Grooming and solicitation">
            Any attempt to build a relationship with a minor for sexual purposes, to solicit sexual
            content or contact from a minor, or to move a minor to another platform for those ends.
          </Item>
          <Item label="Sextortion and trafficking">
            Threatening to share a minor's intimate imagery, and any advertising, solicitation or
            facilitation of the sexual exploitation or trafficking of a minor.
          </Item>
          <Item label="Off-platform conduct">
            Using Lumina to link to, advertise or direct people toward this material elsewhere is
            treated the same as hosting it here.
          </Item>
        </Section>

        <Section title="How we prevent it">
          <Item label="Every video is reviewed by a person before publication">
            Uploads do not appear to anyone until a human reviewer has approved them. Nothing reaches
            the feed on an automated decision alone.
          </Item>
          <Item label="Age is verified, not assumed">
            Lumina is 18+. Every new account declares an age range and a date of birth, both are
            cross-checked, and anyone under 18 is refused before an account exists. Money features
            require a further reviewed identity check.
          </Item>
          <Item label="No minor tier — under-18 accounts are removed">
            There is no supervised or parent-linked account type. An account found to be held by
            someone under 18 is walled off from every contact surface on the server the moment the
            finding is recorded, and then closed. The closure applies to the account, not to a
            shared phone or household connection.
          </Item>
          <Item label="Proactive filtering and audit">
            Keyword filtering runs before a message is delivered, and every privileged action taken
            by staff is written to an audit log.
          </Item>
        </Section>

        <Section title="How to report">
          <Item label="In the app">
            Every message, video, profile and community carries a report action. Reports about child
            safety are prioritised above all other queues and are actioned by a person.
          </Item>
          <Item label="By email">
            <a className="text-accent hover:underline" href="mailto:safety@badgerstudios.net">
              safety@badgerstudios.net
            </a>{" "}
            reaches the team responsible for this policy directly. You do not need an account to
            report, and you may report anonymously.
          </Item>
          <Item label="To the authorities">
            If a child is in immediate danger, contact your local emergency services first. In the
            United States, reports can be made to the NCMEC CyberTipline at{" "}
            <a className="text-accent hover:underline" href="https://report.cybertip.org"
               target="_blank" rel="noopener noreferrer">report.cybertip.org</a>. In the United
            Kingdom, to the IWF at{" "}
            <a className="text-accent hover:underline" href="https://report.iwf.org.uk"
               target="_blank" rel="noopener noreferrer">report.iwf.org.uk</a>.
          </Item>
        </Section>

        <Section title="What we do when we find it">
          <Item label="Immediate removal">
            The content is removed from public access as soon as it is identified, before any appeal
            or review of the account.
          </Item>
          <Item label="Permanent account termination">
            The account is terminated. This is not a strike, a suspension or a warning, and the
            normal appeal path does not apply.
          </Item>
          <Item label="Preservation and reporting">
            Relevant evidence is preserved for law enforcement rather than deleted, and the matter is
            reported to the appropriate authority for the jurisdictions involved. This is the one
            case where our usual practice of deleting data promptly is deliberately overridden.
          </Item>
          <Item label="Related accounts">
            We act on other accounts linked by the same signals, so that terminating one account is
            not simply an invitation to make another.
          </Item>
        </Section>

        <Section title="Who is responsible">
          <Item label="Point of contact">
            Badger Studios LLC is responsible for these standards and for enforcing them. Regulators,
            law enforcement and child-safety organisations can reach us at{" "}
            <a className="text-accent hover:underline" href="mailto:safety@badgerstudios.net">
              safety@badgerstudios.net
            </a>
            .
          </Item>
          <Item label="Keeping this current">
            These standards are reviewed as the product changes. Where this page and the product ever
            disagree, treat it as a fault worth reporting to the address above.
          </Item>
        </Section>

        <footer className="border-t border-hairline pt-6 text-sm text-signal-faint">
          See also our{" "}
          <Link className="text-accent hover:underline" to="/terms">Terms of Service</Link> and{" "}
          <Link className="text-accent hover:underline" to="/privacy">Privacy Policy</Link>.
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
