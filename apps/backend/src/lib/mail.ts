import fs from "node:fs";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { logoAttachment, wrapHtml } from "./mailTemplate.js";

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
  /**
   * Skips the Lumina letterhead and sends `html` exactly as given.
   *
   * Here so that an email which genuinely should not carry the branding has an explicit way to say
   * so, rather than someone reaching for it by bypassing `sendMail`. Nothing uses it yet.
   */
  rawHtml?: boolean;
}

/**
 * The DKIM signing key, read from a file rather than an environment variable.
 *
 * Env vars for this specific secret are a poor fit twice over: a PEM is multi-line, which `.env`
 * and compose handle badly, and anything in `environment:` shows up in plain `docker inspect`
 * output, which is a much wider audience than a 0600 file. `DKIM_PRIVATE_KEY` is still honoured as
 * a fallback so a deployment that has no convenient way to mount a file is not locked out.
 *
 * Read once at startup, not per send: this is on the path of every verification email.
 */
function readDkimKey(): string | null {
  const path = process.env.DKIM_PRIVATE_KEY_FILE?.trim();
  if (path) {
    try {
      return fs.readFileSync(path, "utf8");
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        "[mail] DKIM_PRIVATE_KEY_FILE is set but unreadable — sending UNSIGNED:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }
  return process.env.DKIM_PRIVATE_KEY?.trim() || null;
}

const dkimKey = readDkimKey();

/**
 * A PEM to trust for the SMTP connection, on top of the system CAs.
 *
 * The BadgerOS submission relay presents a self-signed certificate, so the default trust store
 * rejects it. The two ways out are pinning that certificate or turning verification off, and this
 * is the former: **an AUTH password crosses this connection**, and `rejectUnauthorized: false`
 * accepts *any* certificate, which is precisely the shape a machine-in-the-middle needs to collect
 * it. Pinning gives the encryption the same strength while still proving we reached the right host.
 *
 * The relay's operator offered both; there is no reason to take the weaker one.
 */
function readSmtpCa(): string | null {
  const path = process.env.SMTP_TLS_CA_FILE?.trim();
  if (!path) return null;
  try {
    return fs.readFileSync(path, "utf8");
  } catch (error) {
    // Loud, and deliberately NOT falling back to an unverified connection: a config slip must not
    // silently downgrade the link that carries our credentials.
    // eslint-disable-next-line no-console
    console.error(
      "[mail] SMTP_TLS_CA_FILE is set but unreadable — TLS verification will fail:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

const smtpCa = readSmtpCa();

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
    // Where a reply actually goes.
    //
    // Lumina sends from its own address so the mail is identifiably from the app rather than from
    // a person, but people reply to automated mail constantly — and a From with no reachable inbox
    // means those replies vanish. Reply-To points at an address a human reads, so "I never got my
    // code" reaches someone instead of bouncing into nothing.
    replyTo: process.env.SMTP_REPLY_TO?.trim() || undefined,
    /**
     * The envelope sender (SMTP `MAIL FROM`), which is a different thing from the `From:` header
     * and is the one SPF actually checks.
     *
     * badgerstudios.net's SPF record is `v=spf1 ip4:15.204.252.37 -all` — a hard fail for anything
     * sent from this host. Rather than widen that record (which is shared with the BadgerOS mail
     * server and risks its deliverability), mail leaves here with an envelope sender on the
     * `lumina.badgerstudios.net` subdomain, which carries its own SPF record authorising this box.
     * DMARC is published with `aspf=r` (relaxed), under which a subdomain aligns with the parent —
     * so the `From:` header can still read `lumina@badgerstudios.net` and pass.
     *
     * Bounces go to this address, so it should be one that exists or is at least monitored.
     */
    envelopeFrom: process.env.SMTP_ENVELOPE_FROM?.trim() || undefined,
    ca: smtpCa,
    /**
     * DKIM signing. Independent of SPF and worth having even though SPF passes: SPF breaks on any
     * forwarding hop that does not rewrite the envelope (mailing lists, .forward rules), while a
     * DKIM signature survives it. DMARC passes if *either* aligns, so signing turns a single point
     * of failure into two.
     */
    dkim:
      dkimKey && process.env.DKIM_DOMAIN?.trim()
        ? {
            domainName: process.env.DKIM_DOMAIN.trim(),
            keySelector: process.env.DKIM_SELECTOR?.trim() || "lumina",
            privateKey: dkimKey,
          }
        : undefined,
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
    ...(cfg.dkim ? { dkim: cfg.dkim } : {}),
    // `servername` is set explicitly because the pinned certificate's CN is the relay's public
    // hostname; without it, TLS would validate against whatever `host` happens to be, which breaks
    // the moment that is an IP or an internal alias.
    ...(cfg.ca ? { tls: { ca: [cfg.ca], servername: cfg.host } } : {}),
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
      ...(cfg.replyTo ? { replyTo: cfg.replyTo } : {}),
      // Overriding the envelope leaves the visible `From:` header untouched — see `envelopeFrom`.
      // Both fields must be given when overriding at all; nodemailer does not merge one in.
      ...(cfg.envelopeFrom
        ? { envelope: { from: cfg.envelopeFrom, to: message.to } }
        : {}),
      to: message.to,
      subject: message.subject,
      text: message.text,
      // The letterhead is applied here rather than by callers so a new transactional email is
      // branded by existing. See lib/mailTemplate.ts.
      ...(message.html
        ? {
            html: message.rawHtml ? message.html : wrapHtml(message.html),
            // Only attached when the body actually references the cid — a plain-text-only send
            // must not gain a mystery attachment.
            ...(message.rawHtml ? {} : { attachments: logoAttachment() }),
          }
        : {}),
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
