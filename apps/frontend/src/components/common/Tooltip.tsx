import * as RT from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * The app's one tooltip. Replaces native `title=` (OS-styled, ~1s delay, invisible on touch) on an
 * icon-dense UI. Self-contained (bundles its own Provider) so it drops in anywhere without a root
 * Provider. Renders the trigger untouched when `content` is empty, so it's safe to wrap blindly.
 *
 * Keep `aria-label` on the wrapped control for screen readers — a tooltip is not an accessible name.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  delay = 350,
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: RT.TooltipContentProps["side"];
  align?: RT.TooltipContentProps["align"];
  delay?: number;
  className?: string;
}) {
  if (content == null || content === "" || content === false) return <>{children}</>;
  return (
    <RT.Provider delayDuration={delay} skipDelayDuration={200}>
      <RT.Root>
        <RT.Trigger asChild>{children}</RT.Trigger>
        <RT.Portal>
          <RT.Content
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={8}
            className={cn(
              "lm-pop z-[70] max-w-[16rem] select-none rounded-md border border-hairline bg-base-900 px-2 py-1",
              "text-[11px] font-medium leading-snug text-signal shadow-lg",
              className,
            )}
          >
            {content}
            <RT.Arrow className="fill-base-900" width={10} height={5} />
          </RT.Content>
        </RT.Portal>
      </RT.Root>
    </RT.Provider>
  );
}
