import { describe, expect, it } from 'vitest';
import { Http } from '../../src/http';
import { readImage } from '../../src/sources/image';
import { FakeFetch } from '../support/fake-fetch';

// The app shows these images from its own origin: an SVG could run script there.
describe('images from a platform', () => {
  it('are refused unless JPEG, PNG or WebP', async () => {
    const fake = new FakeFetch().on('https://i.ytimg.com/x.svg', { body: '<svg xmlns="http://www.w3.org/2000/svg"/>', headers: { 'Content-Type': 'image/svg+xml' } });

    expect(await readImage(new Http(fake.fetch, 'test', new Set(['i.ytimg.com'])), 'https://i.ytimg.com/x.svg', 1024)).toBeNull();
  });
});
