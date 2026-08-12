import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

/**
 * Outbound email.
 *
 * ## Degrades to a no-op rather than failing
 *
 * Same pattern as `lib/push.ts` and the TURN credentials: with no SMTP configured, `sendMail`
 * returns `false` and logs, and nothing upstream breaks. That matters because this codebase is
 * self-hosted software — somebody will run it without a mail server, and registration failing with
 * a 500 because an email could not be sent would be a much worse first experience than an account
 * that simply is not verified yet.
 *
 * It also means the whole verification flow is testable before any credentials exist: a token can
 * be minted and redeemed end to end with the send call doing nothing.
 *
 * ## Never blocks a request
 *
 * Callers fire and forget. An SMTP server that has gone slow must not turn signup into a
 * thirty-second wait — the user has an account either way, and the email arriving a moment later is
 * invisible to them.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

function config() {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT ?? 587);
  return {
    host,
    port,
    // Port 465 is implicit TLS; 587 and 25 start plaintext and upgrade with STARTTLS. Deriving it
    // from the port rather than asking for another env var gets it right for the overwhelming
    // majority of servers, and SMTP_SECURE overrides when it doesn't.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
    user: process.env.SMTP_USER?.trim(),
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM?.trim() || `Lumina <no-reply@${host.replace(/^smtp\./, "")}>`,
  };
}

export function mailConfigured(): boolean {
  return config() !== null;
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  const cfg = config();
  if (!cfg) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    // Some self-hosted relays accept unauthenticated mail from inside their own network. Passing an
    // auth block with undefined values makes nodemailer attempt AUTH and fail against those, so it
    // is omitted entirely when no user is set.
    ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
    // A slow or unreachable server must not hold a connection open indefinitely.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

/** Returns false when mail is unconfigured or the send failed. Never throws. */
export async function sendMail(message: MailMessage): Promise<boolean> {
  const cfg = config();
  const tx = getTransporter();
  if (!cfg || !tx) return false;

  try {
    await tx.sendMail({
      from: cfg.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return true;
  } catch (error) {
    // Logged, not thrown. The caller has already done the thing the email is *about*.
    // eslint-disable-next-line no-console
    console.error("[mail] send failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

/** Proves the SMTP settings actually work, for the owner console's configuration panel. Separate
 * from sendMail because "can we connect and authenticate" is a different question from "did this
 * one message go", and an operator setting this up needs the first answered on its own. */
export async function verifyMailConnection(): Promise<{ ok: boolean; error?: string }> {
  const tx = getTransporter();
  if (!tx) return { ok: false, error: "SMTP is not configured" };
  try {
    await tx.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Dropped so the next send rebuilds with current settings — used after a config change. */
export function resetMailTransport(): void {
  transporter = null;
}
