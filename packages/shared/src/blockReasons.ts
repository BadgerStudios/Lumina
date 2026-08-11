/**
 * Catalogue of every reason an account or device can be blocked, restricted, or error out.
 *
 * One list, shared by the server (which records the code), the client (which shows `userMessage`),
 * and the owner console (which makes it searchable). The point is that support never has to guess:
 * the person who is stuck can quote a code, and that code resolves to the same explanation and the
 * same remedy everywhere.
 *
 * `userMessage` is what the blocked person sees, so it says what happened and what to do — never
 * the internal detection logic, which would just be a manual for evading it. `staffNote` is the
 * internal half and is only ever exposed to staff and above.
 */

export type BlockSeverity = "INFO" | "RESTRICTED" | "SOFT_BLOCK" | "HARD_BLOCK";

export interface BlockReason {
  code: string;
  title: string;
  category: "age" | "device" | "abuse" | "security" | "technical" | "content";
  severity: BlockSeverity;
  /** Shown to the affected person. */
  userMessage: string;
  /** Internal context — staff and above only. */
  staffNote: string;
  /** Whether the person can lift this themselves, or must contact support. */
  selfResolvable: boolean;
}

export const BLOCK_REASONS: BlockReason[] = [
  // ---- age ----
  {
    code: "AGE_MISMATCH",
    title: "Age answers don't match",
    category: "age",
    severity: "SOFT_BLOCK",
    userMessage:
      "The age range and date of birth on this account don't line up. Contact support and we'll sort it out.",
    staffNote:
      "Selected bracket crosses the 18 boundary against the birth date given. Could be a mis-tap, could be an under-18 account claiming to be an adult. Verify before lifting.",
    selfResolvable: false,
  },
  {
    code: "AGE_UNDER_MINIMUM",
    title: "Under 18 — not eligible",
    category: "age",
    severity: "HARD_BLOCK",
    userMessage:
      "You need to be 18 or over to use Lumina. You're welcome to come back when you are.",
    staffNote:
      "Under 18 by date of birth or by their own selection. Signup refused and the device is placed on a 30-day new-account cooldown — deliberately NOT a permanent ban: permanently banning the people who answer honestly rewards lying, and devices are shared and outlive the condition. Existing accounts on that device are unaffected.",
    selfResolvable: false,
  },
  {
    code: "AGE_MISSING",
    title: "Age not recorded",
    category: "age",
    severity: "RESTRICTED",
    userMessage: "Please finish setting up your account.",
    staffNote:
      "Account predates age collection or never completed it. Treated as a minor for contact restrictions until answered — the safe default when the answer is unknown.",
    selfResolvable: true,
  },
  {
    code: "AGE_CONTACT_RESTRICTED",
    title: "Contact blocked across age groups",
    category: "age",
    severity: "RESTRICTED",
    userMessage: "You can't message this person.",
    staffNote:
      "Adult/minor contact attempt blocked. Expected behaviour, not an incident on its own — but a high volume from one account is worth a look.",
    selfResolvable: false,
  },

  // ---- device ----
  {
    code: "DEVICE_BANNED",
    title: "Device is banned",
    category: "device",
    severity: "HARD_BLOCK",
    userMessage:
      "This device has been banned. If you think that's a mistake, contact support with the reference below.",
    staffNote:
      "Device fingerprint matches a banned account. Fingerprints CAN collide on identical corporate/imaged machines — treat a lone device match with no other signal sceptically.",
    selfResolvable: false,
  },
  {
    code: "DEVICE_UNVERIFIED",
    title: "Device could not be identified",
    category: "device",
    severity: "INFO",
    userMessage: "",
    staffNote:
      "No fingerprint was sent. Normal for API clients, older builds, and hardened browsers. Not suspicious on its own.",
    selfResolvable: true,
  },
  {
    code: "AGE_SIGNUP_COOLDOWN",
    title: "Device on signup cooldown",
    category: "age",
    severity: "SOFT_BLOCK",
    userMessage:
      "New accounts can't be created from this device right now. If you think that's wrong, contact support.",
    staffNote:
      "Follows an under-age signup attempt from this device. Expires on its own. Lift early only if you have reason to believe the original attempt was a mistake — e.g. a parent on a shared machine.",
    selfResolvable: false,
  },
  {
    code: "DEVICE_MANY_ACCOUNTS",
    title: "Unusual number of accounts on one device",
    category: "device",
    severity: "RESTRICTED",
    userMessage: "We've limited new signups from this device for now. Contact support if you need help.",
    staffNote:
      "Many registrations from one fingerprint in a short window. Shared machines (libraries, families, offices) hit this legitimately.",
    selfResolvable: false,
  },

  // ---- security ----
  {
    code: "IP_BANNED",
    title: "Network address is banned",
    category: "security",
    severity: "HARD_BLOCK",
    userMessage: "Access from this network has been blocked. Contact support if you think that's wrong.",
    staffNote:
      "IP matches a ban. Highest collateral risk of any scope — carriers, offices and shared housing put many unrelated people behind one address.",
    selfResolvable: false,
  },
  {
    code: "EMAIL_BANNED",
    title: "Email address is banned",
    category: "security",
    severity: "HARD_BLOCK",
    userMessage: "This email address can't be used to sign up. Contact support if you think that's wrong.",
    staffNote: "Email hash matches a ban issued against a previous account.",
    selfResolvable: false,
  },
  {
    code: "ACCOUNT_BANNED",
    title: "Account is banned",
    category: "abuse",
    severity: "HARD_BLOCK",
    userMessage: "Your account has been banned from this platform.",
    staffNote: "Direct account ban. Reason and appeal state live on the PlatformBan row.",
    selfResolvable: false,
  },
  {
    code: "RATE_LIMITED",
    title: "Too many attempts",
    category: "security",
    severity: "SOFT_BLOCK",
    userMessage: "Too many attempts. Wait a minute and try again.",
    staffNote: "Rate limiter tripped. Self-clearing; no action needed unless it repeats constantly.",
    selfResolvable: true,
  },
  {
    code: "CREDENTIALS_INVALID",
    title: "Wrong email or password",
    category: "security",
    severity: "INFO",
    userMessage: "That email or password isn't right.",
    staffNote:
      "Deliberately does not say WHICH was wrong — distinguishing them tells an attacker whether an address has an account.",
    selfResolvable: true,
  },

  // ---- content ----
  {
    code: "VIDEO_REJECTED",
    title: "Video rejected in review",
    category: "content",
    severity: "INFO",
    userMessage: "A moderator reviewed your video and didn't approve it.",
    staffNote: "Reason given at review time is on the Video row.",
    selfResolvable: true,
  },
  {
    code: "VIDEO_AUTO_UNPUBLISHED",
    title: "Video pulled after reports",
    category: "content",
    severity: "INFO",
    userMessage: "Your video was temporarily hidden and is being re-reviewed.",
    staffNote:
      "Hit the distinct-reporter threshold. Being reported is not proof of anything — re-review on the merits.",
    selfResolvable: false,
  },
  {
    code: "UPLOAD_TOO_LARGE",
    title: "File too large",
    category: "technical",
    severity: "INFO",
    userMessage: "That file is too big. Check the size limit and try again.",
    staffNote: "Exceeded the per-route upload cap.",
    selfResolvable: true,
  },
  {
    code: "UPLOAD_UNSUPPORTED_TYPE",
    title: "Unsupported file type",
    category: "technical",
    severity: "INFO",
    userMessage: "That file type isn't supported here.",
    staffNote: "Extension or mimetype outside the allowlist for that route.",
    selfResolvable: true,
  },
  {
    code: "TRANSCODE_FAILED",
    title: "Video could not be processed",
    category: "technical",
    severity: "INFO",
    userMessage: "We couldn't process that video. Try re-exporting it and uploading again.",
    staffNote: "ffmpeg failed or the file was undecodable. Reason stored on Video.failureReason.",
    selfResolvable: true,
  },
  {
    code: "SERVICE_UNAVAILABLE",
    title: "Service temporarily unavailable",
    category: "technical",
    severity: "SOFT_BLOCK",
    userMessage: "Something's not working on our side. Try again shortly.",
    staffNote: "A dependency (database, Redis, worker) was unreachable. Check the System panel.",
    selfResolvable: true,
  },

  // ---- connection origin ----
  //
  // Two codes, not one, because "we noticed" and "we acted" are different events and conflating
  // them makes the flag table useless: every VPN user would look restricted, and the actual
  // restrictions would be unfindable among them.
  {
    code: "IP_ANONYMISED",
    title: "Connected via VPN, Tor or a datacenter",
    category: "security",
    // INFO on purpose. Using a VPN is not misconduct and most people doing it have ordinary
    // reasons — this is context for a later decision, never a mark against the account.
    severity: "INFO",
    userMessage: "",
    staffNote:
      "Signup or login arrived from a known Tor exit, VPN range or hosting provider. Recorded for pattern-spotting only; nothing is restricted by this alone. iCloud Private Relay is allowlisted and never produces this. Note that residential proxies are undetectable with the free datasets, so absence of this flag is not evidence of a clean connection.",
    selfResolvable: true,
  },
  {
    code: "NEW_ACCOUNT_ANONYMISED_ORIGIN",
    title: "New account on an anonymised connection",
    category: "abuse",
    severity: "RESTRICTED",
    userMessage:
      "New accounts can't upload videos, buy ads or message people they don't know while connected through a VPN or Tor. Turn it off, or come back in a few days — nothing else is affected, and no action is needed on your part.",
    staffNote:
      "Account younger than the trust window AND connected from an anonymised IP. Gates video upload, ad purchase and DMs to non-friends; reading, chatting in servers and existing DMs all still work. Lifts by itself with account age or a clean connection — there is nothing to un-set, so it can never get stuck on.",
    selfResolvable: true,
  },
];

const BY_CODE = new Map(BLOCK_REASONS.map((r) => [r.code, r]));

export function getBlockReason(code: string): BlockReason | undefined {
  return BY_CODE.get(code);
}

/** Free-text search across the catalogue, for the owner console's lookup. */
export function searchBlockReasons(query: string): BlockReason[] {
  const q = query.trim().toLowerCase();
  if (!q) return BLOCK_REASONS;
  return BLOCK_REASONS.filter((r) =>
    [r.code, r.title, r.category, r.severity, r.userMessage, r.staffNote]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}
