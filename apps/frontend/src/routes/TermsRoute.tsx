import { Link } from "react-router-dom";
import { ScrollText } from "lucide-react";

/**
 * Terms of Service.
 *
 * There were none at all — registration linked only to the privacy policy, and nothing anywhere
 * stated the rules of use, who owns uploaded content, what gets an account removed, or what happens
 * to money that has changed hands. For a platform that hosts user-uploaded video and takes card
 * payments, that is a real gap rather than a missing formality.
 *
 * Written the same way the privacy policy was: it describes what this system ACTUALLY does, so that
 * every clause corresponds to something the code enforces. A term the software does not implement is
 * a promise visibly not kept, which is worse than saying nothing.
 *
 * IT IS NOT LEGAL ADVICE AND HAS NOT BEEN REVIEWED BY A LAWYER. The operator should have counsel
 * read it before this instance takes real users at scale — particularly the liability, governing-law
 * and payment sections, which are the ones that need jurisdiction-specific wording this file does
 * not attempt to guess at.
 */
export function TermsRoute() {
  return (
    <div className="min-h-app bg-base-900 px-4 py-10 text-signal">
      <article className="mx-auto max-w-2xl space-y-8">
        <header>
          <Link to="/" className="text-sm text-accent hover:underline">
            ← Back to Lumina
          </Link>
          <h1 className="mt-4 font-display text-3xl">Terms of Service</h1>
          <p className="mt-2 text-sm text-signal-faint">Last updated 20 August 2026</p>
        </header>

        <section className="rounded-xl border border-accent/40 bg-base-800 p-5">
          <h2 className="flex items-center gap-2 font-display text-lg">
            <ScrollText className="h-5 w-5 text-accent" />
            The short version
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-signal-dim">
            You must be 18 or over to use Lumina — there are no accounts for minors. What you
            upload stays yours, but you let us host and show it. Don't post anything illegal or
            anything you don't have the right to post. Videos are reviewed by a person before anyone
            else sees them. Break the rules and your access ends. Everything below says the same
            things with more precision.
          </p>
        </section>

        <Section title="Who may use Lumina">
          <Item label="18 and over — adults only">
            You must be 18 or older to use Lumina. You confirm your age range and date of birth when
            you register; anyone under 18 is refused before an account is created, and that device
            is prevented from immediately signing up again with a different birthday. An account
            with no age on record is restricted until it answers. If we later find an account is
            held by someone under 18, the account is closed. There is no supervised or parent-linked
            tier.
          </Item>
          <Item label="One person, one account">
            You are responsible for what happens under your account, including anything done by
            someone you gave access to. Keep your password to yourself — we will never ask for it,
            and no member of staff can read it.
          </Item>
        </Section>

        <Section title="Your content">
          <Item label="You keep ownership">
            Everything you post — messages, videos, images, captions — remains yours. We claim no
            ownership of it.
          </Item>
          <Item label="What you grant us">
            To run the service at all we need permission to store your content, transcode it into
            other formats and resolutions, generate thumbnails, and show it to the people you have
            chosen to show it to. That permission is limited to operating Lumina, is worldwide only
            because the internet is, and ends when you delete the content — except for copies already
            in backups, which age out on their own retention schedule.
          </Item>
          <Item label="You must have the right to post it">
            Do not upload anything you did not make or do not have permission to use, including music
            and video you do not hold the rights to. If you believe something here infringes your
            copyright, contact us and we will act on it.
          </Item>
        </Section>

        <Section title="What is not allowed">
          <Item label="Anything illegal">
            Most importantly and without any tolerance whatsoever: sexual content involving minors,
            content that sexualises minors in any way, and any attempt to contact or groom a minor.
            This is reported to the authorities, not merely removed.
          </Item>
          <Item label="Harm to other people">
            Harassment, threats, incitement to violence, doxxing, impersonation, and content promoting
            self-harm.
          </Item>
          <Item label="Abuse of the platform">
            Spam, bulk automated account creation, attempts to defeat rate limits or the review queue,
            probing for vulnerabilities without permission, and reselling access to the service.
          </Item>
          <Item label="Circumventing moderation">
            Re-registering after a ban, evading a removal, or using another account to post what was
            taken down.
          </Item>
        </Section>

        <Section title="Moderation, and what happens when you break the rules">
          <Item label="Videos are reviewed before publication">
            Every upload waits in a queue for a human decision before it can appear in the feed.
            Approval is not an endorsement, and it does not stop a video being removed later.
          </Item>
          <Item label="Automatic filtering">
            Server owners may configure keyword rules that block messages before they are sent. This
            is a blunt instrument by design and does not replace human judgement.
          </Item>
          <Item label="Enforcement">
            Depending on severity we may remove content, restrict features, suspend an account, or
            ban it from the platform. Serious cases — anything involving minors, credible threats, or
            criminal activity — result in immediate removal and, where appropriate, a report to law
            enforcement.
          </Item>
          <Item label="Appeals">
            A banned account can submit one appeal, which a human reads. We do not promise a specific
            outcome or turnaround, only that the appeal reaches a person and not a filter.
          </Item>
          <Item label="Records">
            Moderation actions are recorded in an append-only staff log, including who acted and why.
            This exists to make enforcement reviewable, including against ourselves.
          </Item>
        </Section>

        <Section title="Payments">
          <Item label="What can be bought">
            Sparks are an in-app currency usable only inside Lumina for cosmetic items. They are not
            money, cannot be exchanged for money, cannot be transferred between accounts, and have no
            value outside the platform. Advertising campaigns are prepaid: an approved campaign runs
            only once its budget is paid, and delivery stops when that budget is spent.
          </Item>
          <Item label="Processing">
            Card payments are handled by Stripe. We never see or store your card details.
          </Item>
          <Item label="Refunds">
            Contact us if something went wrong with a purchase — a payment that did not deliver what
            it was for will be put right. Beyond that, refunds are at our discretion, subject to any
            statutory right you have where you live, which these terms do not remove.
          </Item>
          <Item label="If your account is terminated">
            Unspent sparks and unspent advertising budget are forfeited when an account is banned for
            breaking these terms. If we close your account for any other reason, you keep whatever
            statutory rights apply.
          </Item>
        </Section>

        <Section title="Ending things">
          <Item label="You can leave at any time">
            Deleting your account removes it permanently. Content you posted in shared spaces may
            remain visible attributed to a deleted user, because removing it would silently rewrite
            other people's conversations.
          </Item>
          <Item label="We can end it too">
            We may suspend or close an account that breaks these terms, and may stop offering the
            service entirely — in which case we will give as much notice as circumstances allow.
          </Item>
        </Section>

        <Section title="The service itself">
          <Item label="Provided as-is">
            Lumina is hosted and operated by Badger Studios on a small scale. We do not promise it
            will be available without interruption, free of defects, or that data will never be
            lost. Keep your own copies of anything you cannot afford to lose.
          </Item>
          <Item label="Changes">
            These terms may change. Material changes will be announced in the app before they take
            effect, and continuing to use Lumina after that means accepting them.
          </Item>
        </Section>

        <Section title="Contact">
          <Item label="Reaching us">
            Reports of illegal content, copyright complaints, appeals and questions about these terms
            all go to the operator of this instance. In-app reporting is the fastest route for
            anything about a specific video, message or account.
          </Item>
        </Section>

        <footer className="border-t border-hairline pt-6">
          <p className="text-xs leading-relaxed text-signal-faint">
            These terms describe how this instance of Lumina actually behaves — each section
            corresponds to something the software enforces. They are written in plain language and
            are <strong>not legal advice</strong>; they have not been reviewed by a lawyer. Before
            this instance operates at scale, or anywhere with specific consumer-protection,
            online-safety or platform-liability rules, someone qualified in those jurisdictions
            should review them — especially the payment, liability and governing-law wording, which
            is deliberately not guessed at here.
          </p>
          <p className="mt-3 text-xs text-signal-faint">
            See also our{" "}
            <Link to="/privacy" className="text-accent hover:underline">
              privacy policy
            </Link>
            .
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
