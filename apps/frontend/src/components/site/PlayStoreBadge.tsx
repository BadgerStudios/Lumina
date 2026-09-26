/**
 * The official "Get it on Google Play" badge, self-hosted (public/badges/google-play.png, Google's
 * own artwork, unmodified, as their badge guidelines require). The trademark line lives in the
 * site footer.
 */
export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.luxffa.lumina";

export function PlayStoreBadge({ className = "" }: { className?: string }) {
  return (
    <a href={PLAY_STORE_URL} target="_blank" rel="noreferrer" className={`play-badge ${className}`} aria-label="Get Lumina on Google Play">
      {/* The artwork carries its own clear space; the negative margin lines its visible edge up
          with neighbouring buttons. */}
      <img src="/badges/google-play.png" alt="Get it on Google Play" width={646} height={250} />
    </a>
  );
}
