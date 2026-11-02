/**
 * Records the real YouTube responses the tests replay from test/fixtures/. It is the only code
 * in the repository that contacts YouTube, and it only runs by hand:
 *
 *   pnpm --filter @subify/server fixtures:record
 *
 * Re-run it when YouTube changes a format, then fix what the tests catch.
 */
import { writeFile } from 'node:fs/promises';

const out = new URL('../test/fixtures/', import.meta.url);

const userAgent = 'Mozilla/5.0 (compatible; feed reader)';
// The same consent cookie the server sends (src/sources/youtube/page.ts): without it, YouTube
// answers a channel page from Europe with a redirect to its consent wall.
const consentCookie = 'SOCS=CAI';

/** Channels picked for what their feeds contain. */
const channels = {
  // Videos, Shorts and live streams.
  nasa: 'UCLA_DiR1FfKNvjuUpBHmylQ',
  // Videos and Shorts, never a live stream: its lives playlist answers 404.
  kurzgesagt: 'UCsXVk37bltHxD1rDPwtNM8Q',
};

const feeds = {
  channel: (id: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,
  videos: (id: string) => `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${id.slice(2)}`,
  shorts: (id: string) => `https://www.youtube.com/feeds/videos.xml?playlist_id=UUSH${id.slice(2)}`,
  lives: (id: string) => `https://www.youtube.com/feeds/videos.xml?playlist_id=UULV${id.slice(2)}`,
};

async function record(name: string, url: string, init: RequestInit = {}): Promise<string> {
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: { 'User-Agent': userAgent, ...init.headers },
  });
  const body = await response.text();
  await writeFile(new URL(name, out), body);
  console.log(`${response.status} ${name} (${body.length} characters)`);

  return body;
}

for (const [name, id] of Object.entries(channels)) {
  for (const [kind, url] of Object.entries(feeds)) {
    const extension = name === 'kurzgesagt' && kind === 'lives' ? 'html' : 'xml';
    await record(`${name}-${kind}.${extension}`, url(id));
  }
}

await record('channel-feed-404.html', feeds.channel('UCxxxxxxxxxxxxxxxxxxxxxx'));
await record('oembed-nasa.json', 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DUleiRdWFG7o&format=json');
await record('oembed-404.txt', 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DAAAAAAAAAAA&format=json');
await record('page-404.html', 'https://www.youtube.com/@this-handle-does-not-exist-xyz', { headers: { Cookie: consentCookie } });

/*
 * A channel page weighs about 2 MB. What the server reads (canonical link, og:title, og:image,
 * the RSS link) sits right after a large inline script, about 820 KB in. The fixture keeps the
 * page up to a little after og:image, verbatim apart from the bodies of inline scripts and
 * styles, which are emptied to keep the repository small. The server stops reading once it
 * found what it needs.
 */
const page = await (
  await fetch('https://www.youtube.com/@NASA', { headers: { 'User-Agent': userAgent, Cookie: consentCookie } })
).text();
const ogImage = page.indexOf('<meta property="og:image"');
const end = page.indexOf('>', ogImage + 2000) + 1;
const trimmed = page
  .slice(0, end)
  .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/g, '$1$2')
  .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/g, '$1$2');
await writeFile(new URL('nasa-page.html', out), `${trimmed}\n<!-- Trimmed by scripts/record-fixtures.ts. -->\n`);
console.log(`200 nasa-page.html (${trimmed.length} of ${page.length} characters kept)`);
