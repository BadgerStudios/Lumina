/**
 * Where a person is sent when the product cannot decide something on its own.
 *
 * Deliberately one constant rather than the address written into each message: it appears in
 * refusal copy, appeal flows and transactional mail, and an address that is right in three places
 * and stale in the fourth sends people into a void at exactly the moment they most need a reply.
 *
 * Overridable by env so a staging deploy does not invite real users to email production support.
 */
export const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL?.trim() || "support@badgerstudios.net";
