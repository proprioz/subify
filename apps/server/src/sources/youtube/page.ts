import { CHANNEL_ID } from './ids';

/**
 * YouTube answers a channel page from Europe with a redirect to its consent wall unless a
 * consent cookie is sent. `SOCS=CAI` is the shortest generic value: it carries no identity
 * and no date, is the same for every request, and is sent by the server,
 * never by or for a user. If YouTube stops accepting it, the page read fails cleanly: a
 * @handle asks for the /channel/ link, and a channel id is added without its avatar.
 */
export const CONSENT_COOKIE = 'SOCS=CAI';

export const MAX_PAGE_BYTES = 3 * 1024 * 1024;

/** Where YouTube keeps avatars: the only hosts an avatar is read from. */
export const AVATAR_HOSTS: readonly string[] = ['yt3.googleusercontent.com', 'yt3.ggpht.com'];

export interface ChannelPage {
  channelId: string | null;
  title: string | null;
  iconUrl: string | null;
}

/**
 * Reads a channel page as it streams in, and says when it has what the server needs: the
 * channel id (canonical link), its title (og:title) and avatar (og:image). They sit about
 * 820 KB into a 2 MB page, so stopping there halves the work, which counts within the
 * 10 ms of CPU a request gets on the Workers Free plan. Each call only searches the new text.
 */
export class ChannelPageScanner {
  readonly page: ChannelPage = { channelId: null, title: null, iconUrl: null };
  private scanned = 0;

  /** Returns true once the id, the title and the avatar were found. */
  scan(text: string): boolean {
    // Start a little before the end of the previous text, so a tag split between two chunks is found.
    const from = Math.max(0, this.scanned - 512);
    this.scanned = text.length;

    this.page.channelId ??= find(text, from, '<link rel="canonical" href="https://www.youtube.com/channel/', (value) =>
      CHANNEL_ID.test(value) ? value : null,
    );
    this.page.title ??= find(text, from, '<meta property="og:title" content="', (value) => decodeEntities(value).trim() || null);
    this.page.iconUrl ??= find(text, from, '<meta property="og:image" content="', icon);

    return this.page.channelId !== null && this.page.title !== null && this.page.iconUrl !== null;
  }
}

function find(text: string, from: number, prefix: string, accept: (value: string) => string | null): string | null {
  const start = text.indexOf(prefix, from);

  if (start === -1) {
    return null;
  }

  const valueStart = start + prefix.length;
  const end = text.indexOf('"', valueStart);

  return end === -1 ? null : accept(text.slice(valueStart, end));
}

function icon(value: string): string | null {
  try {
    const url = new URL(decodeEntities(value));

    return url.protocol === 'https:' && AVATAR_HOSTS.includes(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

function decodeEntities(value: string): string {
  return value.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    const lower = code.toLowerCase();

    if (lower.startsWith('#')) {
      const point = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);

      return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }

    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[lower] ?? entity;
  });
}
