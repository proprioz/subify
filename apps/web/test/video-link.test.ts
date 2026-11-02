import { describe, expect, it } from 'vitest';
import { videoLink } from '../src/data/video-link';

// The app opens a video's link in a new window: a javascript: or data: URL from a damaged or
// hostile answer would run in the app's origin, next to the user's data.
describe('video links', () => {
  it('keeps https links', () => {
    expect(videoLink('https://www.youtube.com/watch?v=abcdefghijk')).toBe('https://www.youtube.com/watch?v=abcdefghijk');
  });

  it.each(['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'http://www.youtube.com/watch?v=x', '/feed', ''])(
    'refuses %s',
    (url) => {
      expect(videoLink(url)).toBeNull();
    },
  );
});
