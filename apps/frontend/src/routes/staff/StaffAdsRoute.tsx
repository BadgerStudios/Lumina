import { AdReviewQueue } from "../../components/staff/AdReviewQueue";

/**
 * Ad review, as a staff section.
 *
 * `/api/ads/review` has always been gated on `requireStaff`, but its only UI lived inside the owner
 * console — a surface staff cannot open. So staff held the permission and had no way to use it, and
 * every ad waited on an owner. This is that door.
 */
export function StaffAdsRoute() {
  return (
    <div className="mx-auto max-w-3xl p-4">
      <p className="mb-3 text-sm leading-relaxed text-signal-dim">
        Campaigns waiting on a decision. The creative is a video in the same public feed as any
        other upload, so it is held to the same standard as the video queue.
      </p>
      <AdReviewQueue />
    </div>
  );
}
