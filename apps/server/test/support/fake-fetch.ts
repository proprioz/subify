import { fixtures, TINY_JPEG } from '../fixtures';
import { FakeFetch } from './fake-fetch-core';
import { type RecordedAnswers, registerRecorded } from './recorded';
import { youtubeUrls } from './youtube-urls';

export { type FakeAnswer, FakeFetch } from './fake-fetch-core';
export { youtubeUrls } from './youtube-urls';

/** Every video id in the recorded feeds. */
export const RECORDED_VIDEOS = [
  ...new Set(
    [fixtures.nasaChannel, fixtures.nasaVideos, fixtures.nasaShorts, fixtures.nasaLives, fixtures.kurzgesagtChannel, fixtures.kurzgesagtVideos, fixtures.kurzgesagtShorts].flatMap((feed) =>
      [...feed.matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g)].map((match) => match[1]!),
    ),
  ),
];

/**
 * Registers the recorded answers of the NASA and Kurzgesagt channels, and a made-up small
 * thumbnail for each of their videos: a channel entering the catalog reads those of its last 7 days.
 */
export function withRecordedChannels(fake: FakeFetch): FakeFetch {
  registerRecorded(fake, fixtures satisfies RecordedAnswers);
  RECORDED_VIDEOS.forEach((id) => fake.on(youtubeUrls.smallThumbnail(id), { body: TINY_JPEG, headers: { 'Content-Type': 'image/jpeg' } }));

  return fake;
}
