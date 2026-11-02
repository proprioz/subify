import { useIonToast } from '@ionic/react';
import { useCallback } from 'react';

/** The tab bar's id: toasts sit just above it. */
export const TAB_BAR_ID = 'tab-bar';

/**
 * Shows a short message above the tab bar. On wide screens the side menu replaces the hidden tab
 * bar, and anchoring to it would throw the toast off screen: it takes the bottom edge instead.
 */
export function useToast(): (message: string, duration?: number) => Promise<void> {
  const [present] = useIonToast();

  return useCallback((message: string, duration = 2000) => present({ message, duration, ...toastPlacement() }), [present]);
}

/** Where a toast goes: above the tab bar while it shows, at the bottom edge otherwise. */
export function toastPlacement(): { position: 'bottom'; positionAnchor?: string } {
  const tabBarShown = (document.getElementById(TAB_BAR_ID)?.getClientRects().length ?? 0) > 0;

  return { position: 'bottom', ...(tabBarShown ? { positionAnchor: TAB_BAR_ID } : {}) };
}
