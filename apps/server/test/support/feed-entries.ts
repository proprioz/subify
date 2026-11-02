import { NASA } from '../fixtures/ids';

/** The live the recorded NASA lives playlist announces: it had not aired, so it has 0 views. */
export const UPCOMING_LIVE = 'pAKqJxuxDgk';

/** A feed entry in YouTube's format, for an upload the recorded feeds do not have. */
export function newEntry(videoId: string, title: string, published: number, views?: number): string {
  const group = views === undefined ? '' : `\n  <media:group><media:community><media:statistics views="${views}"/></media:community></media:group>`;

  return `<entry>
  <id>yt:video:${videoId}</id>
  <yt:videoId>${videoId}</yt:videoId>
  <yt:channelId>${NASA}</yt:channelId>
  <title>${title}</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=${videoId}"/>
  <published>${new Date(published).toISOString()}</published>${group}
 </entry>`;
}

/** The recorded feed once the upcoming live has aired and has views. */
export function aired(feed: string): string {
  return feed.replace('<media:statistics views="0"/>', '<media:statistics views="5321"/>');
}

export function withEntry(feed: string, entry: string): string {
  return feed.replace('<entry>', `${entry}\n <entry>`);
}
