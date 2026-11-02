import { type Http, UpstreamError } from '../http';
import { logError } from '../log';
import type { Image } from '../sources/image';
import type { SourceAdapter } from '../sources/source';

/**
 * The avatar, or null when the platform has none or did not answer. It is read
 * once, when the channel enters the catalog.
 */
export async function avatarOrNothing(source: SourceAdapter, iconUrl: string | null, http: Http): Promise<Image | null> {
  if (iconUrl === null) {
    return null;
  }

  try {
    return await source.readAvatar(iconUrl, http);
  } catch (error) {
    if (!(error instanceof UpstreamError)) {
      logError('Reading an avatar failed', error);
    }

    return null;
  }
}
