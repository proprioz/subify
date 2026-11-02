import type { ParsedInput } from '../source';
import { parseYoutubeInput } from './input';

/**
 * A link to a channel inside a description: its id, @handle, /c/ or /user/ name. Links to videos
 * are left out: each would cost an oEmbed request, and most point to the channel itself. The
 * lookbehind keeps out hosts that only end in "youtube.com".
 */
const CHANNEL_LINK = /(?<![\w.-])(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(@[\p{L}\p{N}._-]+|channel\/UC[0-9A-Za-z_-]{22}|(?:c|user)\/[\p{L}\p{N}._-]+)/gu;

/**
 * The channels other than `channelId` that a description links to, in the order they appear,
 * each once, at most `limit`. The text is the raw feed, where the description is escaped XML:
 * the characters a link may hold are never escaped. What the input parser refuses is skipped.
 */
export function channelMentions(text: string, channelId: string, limit: number): ParsedInput[] {
  const found = new Map<string, ParsedInput>();

  for (const match of text.matchAll(CHANNEL_LINK)) {
    if (found.size >= limit) {
      break;
    }

    // A sentence often ends right after a link: a final period is not part of it.
    const path = match[1]!.replace(/\.+$/, '');
    let input: ParsedInput | null;

    try {
      input = parseYoutubeInput(`https://www.youtube.com/${path}`);
    } catch {
      continue;
    }

    if (input === null || (input.kind === 'channel' && input.externalId === channelId)) {
      continue;
    }

    const key = input.kind === 'channel' ? input.externalId : input.kind === 'handle' ? `@${input.handle.toLowerCase()}` : input.value;

    if (!found.has(key)) {
      found.set(key, input);
    }
  }

  return [...found.values()];
}
