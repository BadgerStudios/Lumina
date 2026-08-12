import fs from "node:fs";
import path from "node:path";

/**
 * The letterhead wrapped around every HTML email Lumina sends.
 *
 * ## Applied in `sendMail`, not by callers
 *
 * Branding that each caller has to remember to apply is branding that drifts: the second
 * transactional email somebody adds will be the unbranded one, and nothing will fail to tell them.
 * Wrapping centrally means a new email is branded by existing, and an email that genuinely should
 * not be can opt out explicitly.
 *
 * ## Written like it is 2003, on purpose
 *
 * Tables, inline styles, and no external stylesheet. Mail clients are not browsers — Gmail strips
 * `<style>` blocks in some contexts, Outlook renders through Word's HTML engine, and neither
 * supports flexbox or CSS custom properties. Everything here is deliberately the boring version
 * that renders the same in all of them.
 *
 * ## The logo is attached, not linked
 *
 * A `cid:` reference to an inline attachment, rather than an `https://` URL to our own server.
 * Remote images in email are blocked by default in most clients until the reader clicks "display
 * images", so a linked logo shows as a broken-image placeholder at the top of a verification email
 * — worse than no logo at all. `contentDisposition: "inline"` is what keeps it out of the
 * attachment list; without it Gmail shows the file as a download and still breaks the `cid`.
 */

/** Where the logo lives inside the runtime image (see the Dockerfile's assets COPY). Resolved from
 * cwd rather than `__dirname` because the bundled output sits in `dist/` while assets do not. */
const LOGO_PATH = path.resolve(process.cwd(), "assets/lumina-logo.png");

export const LOGO_CID = "lumina-logo";

/**
 * Brand palette, matching `apps/frontend/src/index.css`.
 *
 * These are the app's own tokens rather than the approximations that came over the coordination
 * channel — an email that is a few shades off the product reads as a phishing attempt, which for a
 * message whose entire job is "click this link to confirm your account" is the exact wrong feeling.
 */
const VOID = "#0a0714";
const HAIRLINE = "#2e2350";
const SIGNAL = "#f2eefc";
const ION = "#8b5cf6";

/** True when the logo can actually be attached. Checked once: a missing file must degrade to an
 * unbranded email, never to no email. */
const logoAvailable = ((): boolean => {
  try {
    fs.accessSync(LOGO_PATH, fs.constants.R_OK);
    return true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[mail] logo not readable at ${LOGO_PATH} — sending unbranded`);
    return false;
  }
})();

export function logoAttachment(): Array<{
  filename: string;
  path: string;
  cid: string;
  contentDisposition: "inline";
}> {
  if (!logoAvailable) return [];
  return [
    {
      filename: "lumina-logo.png",
      path: LOGO_PATH,
      cid: LOGO_CID,
      contentDisposition: "inline",
    },
  ];
}

/** Wraps a message body in the Lumina letterhead. `body` is trusted HTML built by us — callers are
 * responsible for escaping anything user-supplied before it gets here. */
export function wrapHtml(body: string): string {
  // Only reference the cid when the attachment will actually exist, otherwise the header renders as
  // a broken image.
  const logo = logoAvailable
    ? `<img src="cid:${LOGO_CID}" width="36" height="36" alt=""
         style="display:block;border:0;border-radius:9px">`
    : "";

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f2f8">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:#f4f2f8;padding:24px 12px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;
                      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
          <tr>
            <td style="background:${VOID};padding:18px 24px;border-bottom:1px solid ${HAIRLINE}">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  ${logo ? `<td style="padding-right:12px">${logo}</td>` : ""}
                  <td style="color:${SIGNAL};font-size:19px;font-weight:700;letter-spacing:-0.2px">
                    Lumina
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 24px;color:#1c1830;font-size:15px;line-height:1.6">
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px 22px;border-top:1px solid #e7e3f0;color:#6b6486;
                       font-size:12px;line-height:1.5">
              Sent by Lumina. If you weren't expecting this, you can safely ignore it.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** A call-to-action button, as a table rather than a styled `<a>`: Outlook ignores padding on inline
 * elements, so a padded anchor collapses to bare underlined text there. */
export function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"
                 style="margin:22px 0">
  <tr>
    <td style="background:${ION};border-radius:9px">
      <a href="${href}"
         style="display:inline-block;padding:12px 22px;color:#ffffff;font-size:15px;
                font-weight:600;text-decoration:none">${label}</a>
    </td>
  </tr>
</table>`;
}

/** Secondary text inside the light card. Not the dark theme's `--signal-dim`: that token is tuned
 * for contrast against `--void`, and on white it is unreadably pale. */
export const MUTED_TEXT_STYLE = "color:#6b6486;font-size:13px;line-height:1.5";
