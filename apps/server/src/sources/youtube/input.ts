import { guessHandles } from '@subify/shared';
import { InputError, type ParsedInput } from '../source';
import { CHANNEL_ID, VIDEO_ID } from './ids';

const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const SHORT_LINK_HOST = 'youtu.be';
const HANDLE = /^[\p{L}\p{N}._-]{3,30}$/u;
/** The name in a /c/ or /user/ link. */
const CUSTOM_NAME = /^[\p{L}\p{N}._-]{1,100}$/u;
const MAX_LENGTH = 2048;
/** Text that may be a channel's name: nothing that belongs to a link or a @handle. */
const NAME = /^[^/:@?#]+$/;

const NOT_A_CHANNEL = 'This link doesn’t point to a channel. Paste a link to the channel, its @handle, or one of its videos.';

/**
 * Reads a YouTube link or id without any request: a channel id (UC…), a channel, feed, handle,
 * /c/ or /user/ link, or a link to a video. Only https links on youtube.com, www.youtube.com,
 * m.youtube.com and youtu.be are accepted, without credentials or port. The result only carries
 * ids and names checked against strict patterns: the server builds its own URLs from them and
 * never fetches what the user typed.
 */
export function parseYoutubeInput(raw: string): ParsedInput | null {
  const input = raw.trim();

  if (input === '' || input.length > MAX_LENGTH) {
    throw new InputError('invalid_link', 'Paste a link to a channel.');
  }

  if (/\s/.test(input)) {
    // Words with no link in them are a channel's name, which guessHandles reads.
    if (NAME.test(input.replace(/^@/, ''))) {
      return null;
    }

    throw new InputError('invalid_link', 'Add one channel at a time.');
  }

  if (CHANNEL_ID.test(input)) {
    return { kind: 'channel', externalId: input };
  }

  if (input.startsWith('@')) {
    return handle(input.slice(1));
  }

  const url = parseUrl(input);

  if (url === null) {
    return null;
  }

  const host = url.hostname.toLowerCase();

  if (host !== SHORT_LINK_HOST && !HOSTS.has(host)) {
    return null;
  }

  if (url.protocol !== 'https:') {
    throw new InputError('invalid_link', 'Only https links are accepted.');
  }

  if (url.username !== '' || url.password !== '' || url.port !== '') {
    throw new InputError('invalid_link', NOT_A_CHANNEL);
  }

  const segments = url.pathname.split('/').filter((segment) => segment !== '').map(decode);

  if (host === SHORT_LINK_HOST) {
    return video(segments[0]);
  }

  const [first, second] = segments;

  if (first === undefined) {
    throw new InputError('invalid_link', NOT_A_CHANNEL);
  }

  if (first.startsWith('@')) {
    return handle(first.slice(1));
  }

  switch (first) {
    case 'channel':
      return channel(second);
    case 'c':
    case 'user':
      if (second === undefined || !CUSTOM_NAME.test(second)) {
        throw new InputError('invalid_link', NOT_A_CHANNEL);
      }

      return { kind: 'other', value: `${first}:${second}` };
    case 'feeds':
      return feed(url);
    case 'watch':
      return video(url.searchParams.get('v') ?? undefined);
    case 'shorts':
    case 'live':
    case 'embed':
    case 'v':
      return video(second);
    default:
      throw new InputError('invalid_link', NOT_A_CHANNEL);
  }
}

export { guessHandles };

function parseUrl(input: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`;

  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new InputError('invalid_link', NOT_A_CHANNEL);
  }
}

function channel(id: string | undefined): ParsedInput {
  if (id === undefined || !CHANNEL_ID.test(id)) {
    throw new InputError('invalid_link', 'This channel link is incomplete. Copy it again from the channel’s page.');
  }

  return { kind: 'channel', externalId: id };
}

function handle(name: string): ParsedInput {
  if (!HANDLE.test(name)) {
    throw new InputError('invalid_link', 'This @handle isn’t valid.');
  }

  return { kind: 'handle', handle: name };
}

function video(id: string | undefined): ParsedInput {
  if (id === undefined || !VIDEO_ID.test(id)) {
    throw new InputError('invalid_link', 'This video link is incomplete. Copy it again from the video.');
  }

  return { kind: 'other', value: `video:${id}` };
}

/** A feed link: the channel feed, or one of its uploads playlists (UU…, UULF…, UUSH…, UULV…). */
function feed(url: URL): ParsedInput {
  const channelId = url.searchParams.get('channel_id');

  if (channelId !== null) {
    return channel(channelId);
  }

  const playlist = /^UU(?:LF|SH|LV)?([0-9A-Za-z_-]{22})$/.exec(url.searchParams.get('playlist_id') ?? '');

  if (playlist?.[1] !== undefined) {
    return channel(`UC${playlist[1]}`);
  }

  throw new InputError('invalid_link', NOT_A_CHANNEL);
}
