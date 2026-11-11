import { useLayoutEffect, type RefObject } from 'react';

/**
 * Sizes a textarea to its content (at least one row) whenever the value or its width changes.
 * In script rather than CSS field-sizing, which WebKit (and so the iOS Pi Browser) lacks
 */
export const useAutoGrow = (
  ref: RefObject<HTMLTextAreaElement | null>,
  value: unknown,
) => {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      // The borders too: the height includes them (border-box), scrollHeight doesn't
      const borders = el.offsetHeight - el.clientHeight;
      el.style.height = `${el.scrollHeight + borders}px`;
    };
    fit();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [ref, value]);
};
