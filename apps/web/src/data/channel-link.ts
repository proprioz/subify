const CHANNEL_ID = /^UC[0-9A-Za-z_-]{22}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const LINK_HOSTS = new Set([...HOSTS, 'music.youtube.com', 'youtu.be']);

/**
 * The channel key a link points to, when it can be read without asking anyone: a channel id
 * (UC…), a /channel/ link or a feed link. Anything else (a @handle, a video) needs the server,
 * and gives null. The server applies the stricter checks; this only has to agree with it on
 * the links it does read.
 */
export function localChannelKey(input: string): string | null {
  const text = input.trim();

  if (CHANNEL_ID.test(text)) {
    return `youtube:${text}`;
  }

  let url: URL;

  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname.toLowerCase()) || url.username !== '' || url.port !== '') {
    return null;
  }

  const [first, second] = url.pathname.split('/').filter((segment) => segment !== '');
  const id = first === 'channel' ? second : first === 'feeds' ? url.searchParams.get('channel_id') : null;

  return id !== null && id !== undefined && CHANNEL_ID.test(id) ? `youtube:${id}` : null;
}

/**
 * Whether text typed in the channel search names a channel to add, a @handle or a link, rather
 * than words to look for in the list. Enter looks up only such text: a name typed to search the
 * list, then Enter to close the keyboard, never reaches the server.
 */
export function isChannelInput(input: string): boolean {
  const text = input.trim();

  if (/\s/.test(text)) {
    return false;
  }

  if (/^@[\p{L}\p{N}._-]{3,}$/u.test(text) || CHANNEL_ID.test(text)) {
    return true;
  }

  try {
    return LINK_HOSTS.has(new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Whether text that is not a channel input may be a channel's name, which the server turns into
 * the @handles such a channel likely has. Being words to search the list too, it is looked up only
 * from its button, never on Enter. The server applies the same rule: nothing of a link in it.
 */
export function isChannelName(input: string): boolean {
  const text = input.trim().replace(/^@/, '');

  return !isChannelInput(input) && /^[^/:@?#]+$/.test(text) && (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3;
}

const HANDLE = /^[\w.-]{3,30}$/;

/**
 * The @handle text names, without the "@": '@name', or a youtube.com/@name link. Null for
 * anything else. Handles ignore case: the handle index lowercases them.
 */
export function localHandle(input: string): string | null {
  const text = input.trim();

  if (text.startsWith('@')) {
    return HANDLE.test(text.slice(1)) ? text.slice(1) : null;
  }

  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    const [first] = url.pathname.split('/').filter((segment) => segment !== '');

    return HOSTS.has(url.hostname.toLowerCase()) && first?.startsWith('@') === true && HANDLE.test(first.slice(1)) ? first.slice(1) : null;
  } catch {
    return null;
  }
}

/** An item's link on its platform, from its id, as the server builds it. */
export function itemUrl(source: string, id: string, type: string): string {
  if (source !== 'youtube') {
    return '';
  }

  return type === 'short' ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`;
}
