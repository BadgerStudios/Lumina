import { mailConfigured, sendMail } from "./mail.js";
import { prisma } from "../db/prisma.js";

/**
 * "Something changed on your account" — the out-of-band trace that makes account theft visible.
 *
 * Neither a password change nor a detected token replay told the person on the account, so anyone
 * holding a live session could act leaving no trace outside the app they had already taken over.
 *
 * Deliberately carries no one-click undo link: a link in this mail is a fresh thing to phish. If
 * it was not them, the useful action is to change the password inside the app they already trust.
 * Fire-and-forget — a mail outage must never fail the action the person actually asked for.
 */
export async function notifyAccountChange(
  userId: string,
  what: string,
  advice = "If that was not you, change your password now and sign out other devices from Settings.",
): Promise<void> {
  if (!mailConfigured()) return;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, username: true },
    });
    if (!user?.email) return;
    void sendMail({
      to: user.email,
      subject: `Lumina security: ${what.toLowerCase()}`,
      text: [`Hi ${user.username},`, "", `${what} on your Lumina account just now.`, "", advice].join("\n"),
    });
  } catch {
    /* never break the caller */
  }
}
