import { useEffect, useRef } from "react";

/** Mounted modal owners, oldest first. Only the newest reacts to Escape, so closing a nested dialog
 *  doesn't also close the one underneath it. */
const stack: symbol[] = [];

/**
 * Calls `onEscape` when Escape is pressed while this modal is the topmost one.
 *
 * Also stands down while a Radix dialog (the app's themed confirm/prompt boxes, which handle Escape
 * themselves) is open on top, for the same reason.
 */
export function useEscapeKey(onEscape: () => void): void {
  const latest = useRef(onEscape);
  latest.current = onEscape;

  useEffect(() => {
    const id = Symbol("modal");
    stack.push(id);
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || stack[stack.length - 1] !== id) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
      latest.current();
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, []);
}
