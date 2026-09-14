import type { ComponentType, ReactNode } from "react";

// Consistent empty-state voice + iconography. The app had "No X yet" / "Nothing here" / "Nothing yet"
// scattered with/without an icon. Use this so every empty surface reads the same.
export function EmptyState({
  icon: IconCmp,
  title,
  description,
  action,
  className = "",
}: {
  icon?: ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 px-6 py-10 text-center ${className}`}>
      {IconCmp && (
        <span className="text-signal-faint">
          <IconCmp size={28} strokeWidth={1.5} />
        </span>
      )}
      <p className="font-display text-sm font-semibold text-signal-dim">{title}</p>
      {description && <p className="max-w-xs text-xs leading-relaxed text-signal-faint">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
