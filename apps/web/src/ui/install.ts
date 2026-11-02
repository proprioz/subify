/**
 * How a browser adds the app to the home screen when it offers no install button of its own. Only
 * Chromium browsers fire `beforeinstallprompt`; the others install from a menu, which the app can
 * only describe.
 */
export type InstallGuide = 'ios-safari' | 'ios-other' | 'android' | 'mac-safari';

/** How the app can be installed on this device, if it is not already. */
export type InstallState = 'installed' | 'prompt' | InstallGuide | 'unavailable';

export interface BrowserTraits {
  /** The app runs from the home screen, not in a browser tab. */
  standalone: boolean;
  /** The browser offered its own install dialog (`beforeinstallprompt`). */
  canPrompt: boolean;
  userAgent: string;
  /** Tells an iPad, whose Safari presents itself as a Mac, from a Mac. */
  maxTouchPoints: number;
}

/** iPhone or iPad, whatever the browser, installed app included. */
export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** Browsers on iOS other than Safari, which share its engine but put Share elsewhere. */
const IOS_OTHER_BROWSERS = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\//;

export function installState({ standalone, canPrompt, userAgent, maxTouchPoints }: BrowserTraits): InstallState {
  if (standalone) {
    return 'installed';
  }

  if (canPrompt) {
    return 'prompt';
  }

  const safari = /Version\/[\d.]+.*Safari\//.test(userAgent);

  if (isIos(userAgent, maxTouchPoints)) {
    return safari && !IOS_OTHER_BROWSERS.test(userAgent) ? 'ios-safari' : 'ios-other';
  }

  if (/Android/.test(userAgent)) {
    return 'android';
  }

  // Safari adds web apps to the Dock from macOS Sonoma, Safari 17.
  const version = /Version\/(\d+)/.exec(userAgent)?.[1];

  if (/Macintosh/.test(userAgent) && safari && !/Chrome|Chromium|Edg\/|Firefox/.test(userAgent) && Number(version) >= 17) {
    return 'mac-safari';
  }

  return 'unavailable';
}

/** The states where the app offers to install: a button of the browser's own, or a guide. */
export function canInstall(state: InstallState): state is 'prompt' | InstallGuide {
  return state !== 'installed' && state !== 'unavailable';
}

/**
 * On iOS the app on the Home Screen keeps its own storage, apart from the browser's: channels
 * followed in the browser do not come along.
 */
export function startsEmptyOnceInstalled(guide: InstallGuide): boolean {
  return guide === 'ios-safari' || guide === 'ios-other';
}
