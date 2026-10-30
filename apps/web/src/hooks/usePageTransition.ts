import { useLayoutEffect, useRef } from "react";

/** Animate the current surface without remounting editors or retaining old-page snapshots. */
export function usePageTransition<T extends HTMLElement>(key?: string) {
  const surface = useRef<T>(null);
  const previous = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = key;
    const element = surface.current;
    if (!element || !key || last === undefined || last === key) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches || typeof element.animate !== "function") return;
    const animation = element.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
    const reduce = () => {
      if (motion.matches) animation.cancel();
    };
    motion.addEventListener("change", reduce);
    return () => {
      animation.cancel();
      motion.removeEventListener("change", reduce);
    };
  }, [key]);
  return surface;
}
