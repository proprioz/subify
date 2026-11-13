import { describe, expect, it } from 'vitest';
import { openVideoUrl } from '../src/ui/open-video';

const LINK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const KEY = 'youtube:dQw4w9WgXcQ';
const FALLBACK = 'S.browser_fallback_url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  ipadSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  androidEdge: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36 EdgA/139.0.0.0',
  androidFirefox: 'Mozilla/5.0 (Android 15; Mobile; rv:142.0) Gecko/142.0 Firefox/142.0',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
};

const on = (userAgent: string, maxTouchPoints = 0, standalone = false) => ({ userAgent, maxTouchPoints, standalone });

// A plain youtube.com link goes to the YouTube app whenever it is installed: without these
// addresses, “Open in the browser” would open the app on phones, and an intent to the wrong
// browser would take the user out of theirs.
describe('where a video opens', () => {
  it('asks Android for the YouTube app by name, back to the link in the browser without it', () => {
    expect(openVideoUrl(LINK, 'app', KEY, on(UA.androidChrome))).toBe(`intent://www.youtube.com/watch?v=dQw4w9WgXcQ#Intent;scheme=https;package=com.google.android.youtube;${FALLBACK};end`);
  });

  it('asks Android for the browser running when its user agent names it', () => {
    expect(openVideoUrl(LINK, 'browser', KEY, on(UA.androidChrome))).toBe(`intent://www.youtube.com/watch?v=dQw4w9WgXcQ#Intent;scheme=https;package=com.android.chrome;${FALLBACK};end`);
    expect(openVideoUrl(LINK, 'browser', KEY, on(UA.androidSamsung))).toContain(';package=com.sec.android.app.sbrowser;');
    // Edge's user agent says Chrome too: sending its user to Chrome would change their browser.
    expect(openVideoUrl(LINK, 'browser', KEY, on(UA.androidEdge))).toBe(LINK);
    expect(openVideoUrl(LINK, 'browser', KEY, on(UA.androidFirefox))).toBe(LINK);
  });

  it('sends the app installed on iOS to Safari for the browser, iPad included, and lets universal links open the app', () => {
    expect(openVideoUrl(LINK, 'browser', KEY, on(UA.iphoneSafari, 5, true))).toBe('x-safari-https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(openVideoUrl(LINK, 'browser', KEY, on(UA.ipadSafari, 5, true))).toBe('x-safari-https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(openVideoUrl(LINK, 'app', KEY, on(UA.iphoneSafari, 5, true))).toBe(LINK);
    // In a Safari tab, the scheme isn't known to work: the link is left to iOS.
    expect(openVideoUrl(LINK, 'browser', KEY, on(UA.iphoneSafari, 5))).toBe(LINK);
  });

  it('opens the link itself on a computer, either way', () => {
    expect(openVideoUrl(LINK, 'app', KEY, on(UA.macChrome))).toBe(LINK);
    expect(openVideoUrl(LINK, 'browser', KEY, on(UA.ipadSafari, 0))).toBe(LINK);
  });
});
