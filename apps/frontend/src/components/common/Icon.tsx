import type { ComponentType } from "react";

// One size scale for lucide icons. The app had ~15 ad-hoc `size=` values (12/13/14/15/16/17/18/19…),
// indistinguishable by eye but inconsistent. Prefer these named sizes for new/edited code.
//   xs — dense inline meta (badges, timestamps)   sm — default UI (buttons, rows)
//   md — primary actions / headers                lg — large affordances / list leading icons
export const ICON = { xs: 14, sm: 16, md: 20, lg: 24 } as const;
export type IconSize = keyof typeof ICON;

type LucideLike = ComponentType<{ size?: number | string; strokeWidth?: number; className?: string }>;

/**
 * Optional thin wrapper to render a lucide icon at a named size, with a lighter stroke for large
 * decorative glyphs (which otherwise look heavy next to 14–16px ones).
 *   <Icon as={Send} size="sm" />
 */
export function Icon({
  as: Component,
  size = "sm",
  strokeWidth,
  className,
}: {
  as: LucideLike;
  size?: IconSize;
  strokeWidth?: number;
  className?: string;
}) {
  const px = ICON[size];
  return <Component size={px} strokeWidth={strokeWidth ?? (px >= 28 ? 1.5 : undefined)} className={className} />;
}
