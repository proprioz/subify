import { useSyncExternalStore } from 'react';

/** Ionic's breakpoints: `lg` is where the split pane in App.tsx (`when="lg"`) shows the side menu. */
const BREAKPOINTS = { lg: '(min-width: 992px)', xl: '(min-width: 1200px)' } as const;

/** Whether the screen is at least as wide as an Ionic breakpoint, following window resizes. */
export function useWideScreen(breakpoint: keyof typeof BREAKPOINTS = 'lg'): boolean {
  const media = BREAKPOINTS[breakpoint];

  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(media);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(media).matches,
  );
}
