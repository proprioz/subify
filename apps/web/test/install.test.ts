import { describe, expect, it } from 'vitest';
import { installState, startsEmptyOnceInstalled } from '../src/ui/install';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  ipadSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/139.0.7258.76 Mobile/15E148 Safari/604.1',
  iphoneEdge: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/139.0.3405.86 Mobile/15E148 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 15; Mobile; rv:142.0) Gecko/142.0 Firefox/142.0',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  macSafari16: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0',
};

const browser = (userAgent: string, maxTouchPoints = 0) => ({ standalone: false, canPrompt: false, userAgent, maxTouchPoints });

// Otherwise users get no way to install, or the wrong steps: an iPad presents itself as a Mac, and Firefox on Android has no install dialog.
describe('how the app offers to install', () => {
  it('stays quiet once installed, and prefers the browser’s own dialog when there is one', () => {
    expect(installState({ ...browser(UA.iphoneSafari), standalone: true })).toBe('installed');
    expect(installState({ ...browser(UA.androidChrome), canPrompt: true })).toBe('prompt');
  });

  it('guides Safari on an iPhone and on an iPad, which presents itself as a Mac', () => {
    expect(installState(browser(UA.iphoneSafari, 5))).toBe('ios-safari');
    expect(installState(browser(UA.ipadSafari, 5))).toBe('ios-safari');
  });

  it('guides other iOS browsers apart from Safari, since Share sits elsewhere', () => {
    expect(installState(browser(UA.iphoneChrome, 5))).toBe('ios-other');
    expect(installState(browser(UA.iphoneEdge, 5))).toBe('ios-other');
  });

  it('guides Android browsers through their menu while no install dialog is offered', () => {
    expect(installState(browser(UA.androidFirefox))).toBe('android');
    expect(installState(browser(UA.androidChrome))).toBe('android');
  });

  it('guides Safari on a Mac from version 17 only, and offers nothing where there is no way', () => {
    expect(installState(browser(UA.ipadSafari))).toBe('mac-safari');
    expect(installState(browser(UA.macSafari16))).toBe('unavailable');
    expect(installState(browser(UA.macChrome))).toBe('unavailable');
    expect(installState(browser(UA.macFirefox))).toBe('unavailable');
  });

  // Otherwise users who already follow channels install an app that starts empty, unwarned: iOS and Safari's “Add to Dock” keep its storage apart.
  it('walks through a backup wherever the installed app starts empty', () => {
    expect(startsEmptyOnceInstalled('ios-safari')).toBe(true);
    expect(startsEmptyOnceInstalled('ios-other')).toBe(true);
    expect(startsEmptyOnceInstalled('mac-safari')).toBe(true);
    expect(startsEmptyOnceInstalled('android')).toBe(false);
  });
});
