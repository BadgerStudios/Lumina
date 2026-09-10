import { mailConfigured, sendMail } from "./mail.js";
import { prisma } from "../db/prisma.js";

/**
 * "Your card was declined" — the notice that turns a silent lapse into something fixable.
 *
 * Stripe retries a failed subscription payment several times over about two weeks before
 * giving up, and the subscription sits in PAST_DUE throughout. Premium deliberately keeps the
 * perks during that window, so without this mail the grace period is invisible from both ends:
 * the customer has no idea anything is wrong, and the first thing they notice is the
 * cancellation.
 *
 * Deliberately carries NO link, for the same reason lib/accountNotice.ts does not: an
 * unexpected mail about money with a button in it is the most phishable thing we could send,
 * and the safest habit to build in a customer is to open the app they already trust. It names
 * the place instead.
 *
 * Fire-and-forget — a mail outage must never fail the webhook and make Stripe redeliver.
 */
export async function notifyPaymentFailed(
  userId: string,
  details: { amountCents: number; currency: string; nextAttempt: Date | null },
): Promise<void> {
  if (!mailConfigured()) return;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, username: true },
    });
    if (!user?.email) return;

    const amount = (details.amountCents / 100).toFixed(2);
    const currency = details.currency.toUpperCase();
    const when = details.nextAttempt
      ? `We'll try again on ${details.nextAttempt.toUTCString().slice(0, 16)}.`
      : "That was the last automatic attempt.";

    void sendMail({
      to: user.email,
      subject: "Lumina billing: your payment didn't go through",
      text: [
        `Hi ${user.username},`,
        "",
        `We couldn't take the ${currency} ${amount} payment for your Lumina subscription.`,
        "",
        when,
        "Your subscription stays active in the meantime — nothing has been cancelled.",
        "",
        "To fix it, open Lumina and go to Settings then Billing to update your card.",
        "",
        "We haven't put a link in this email on purpose. Anyone can send an email that looks",
        "like this one, so please reach billing from inside the app rather than from a message.",
      ].join("\n"),
    });
  } catch {
    /* never break the caller */
  }
}
