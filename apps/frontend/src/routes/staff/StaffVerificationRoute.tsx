import { OwnerAgeReviewsPanel } from "../../owner/OwnerAgeReviewsPanel";

/**
 * Age-verification queue in the staff suite.
 *
 * The panel itself is shared with the owner console rather than duplicated: it is the same queue,
 * the same decision, and the same audit trail — only the shell around it differs. The API behind it
 * is requireStaff, so this route is reachable by the people who actually work the queue instead of
 * only by an owner.
 */
export function StaffVerificationRoute() {
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <h1 className="font-display text-xl text-signal">Age verification</h1>
      <p className="mt-1 text-sm text-signal-dim">
        New accounts waiting on a decision. Check that the person in the selfie matches the ID and
        that the date of birth clears the age requirement. Both images are deleted automatically
        within 24 hours of your decision.
      </p>
      <div className="mt-5">
        <OwnerAgeReviewsPanel />
      </div>
    </div>
  );
}
