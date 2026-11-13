import { isIos } from './install';

export type OpenIn = 'app' | 'browser';

export interface Device {
  /** The app runs from the home screen, not in a browser tab. */
  standalone: boolean;
  userAgent: string;
  /** Tells an iPad, whose Safari presents itself as a Mac, from a Mac. */
  maxTouchPoints: number;
}

const YOUTUBE_APP = 'com.google.android.youtube';

/**
 * The address that opens a video's link in the platform's app or in the browser. A plain link lets
 * the system choose: iOS and Android hand youtube.com links to the YouTube app when it is installed
 * (universal links, app links), and a computer opens a tab. So on Android the app is asked for by
 * name, in an intent that falls back to the link in the browser when the app is missing; and the
 * browser is asked for by name wherever the system would give the link to the app: Safari, from the
 * app installed on iOS (`x-safari-https:`, which iOS hands to Safari), and on Android the browser
 * running, when its user agent names it. In a Safari tab, iOS decides: Safari's own scheme isn't
 * known to work from a page it shows, and a tap that does nothing is worse than the app opening.
 */
export function openVideoUrl(link: string, where: OpenIn, key: string, device: Device): string {
  const url = new URL(link);
  const android = /Android/.test(device.userAgent);

  if (where === 'app') {
    return android && key.startsWith('youtube:') ? intent(url, YOUTUBE_APP) : link;
  }

  if (isIos(device.userAgent, device.maxTouchPoints)) {
    return device.standalone ? `x-safari-${url.href}` : link;
  }

  const browser = android ? androidBrowser(device.userAgent) : null;

  return browser === null ? link : intent(url, browser);
}

/** Opens a video's link in the platform's app or in the browser, from a tap. */
export function openVideo(link: string, where: OpenIn, key: string): void {
  void window.open(openVideoUrl(link, where, key, thisDevice()), '_blank', 'noopener,noreferrer');
}

export function thisDevice(): Device {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

  return { standalone, userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints };
}

/** Chrome's intent syntax (developer.chrome.com/docs/android/intents), which Android browsers share. */
function intent(url: URL, androidPackage: string): string {
  return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;package=${androidPackage};S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
}

/**
 * The Android package of the browser running, or null when the user agent doesn't tell it: the
 * browsers built on Chromium that name themselves aren't Chrome, and an app's web view is no browser.
 */
function androidBrowser(userAgent: string): string | null {
  if (/SamsungBrowser\//.test(userAgent)) {
    return 'com.sec.android.app.sbrowser';
  }

  if (/Chrome\/[\d.]+ Mobile/.test(userAgent) && !/EdgA\/|OPR\/|YaBrowser\/|; wv\)|Version\/[\d.]+ Chrome\//.test(userAgent)) {
    return 'com.android.chrome';
  }

  return null;
}
