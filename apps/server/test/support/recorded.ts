import { KURZGESAGT, NASA, NASA_AVATAR, NASA_VIDEO, TINY_JPEG } from '../fixtures/ids';
import type { FakeFetch } from './fake-fetch-core';
import { youtubeUrls } from './youtube-urls';

/** The recorded files, by name. Tests load them through Vite, scripts/seed-dev.ts from the disk. */
export interface RecordedAnswers {
  nasaChannel: string;
  nasaVideos: string;
  nasaShorts: string;
  nasaLives: string;
  nasaPage: string;
  oembedNasa: string;
  kurzgesagtChannel: string;
  kurzgesagtVideos: string;
  kurzgesagtShorts: string;
  kurzgesagtLives: string;
  page404: string;
}

/** Answers every URL the server reads for the NASA and Kurzgesagt channels. */
export function registerRecorded(fake: FakeFetch, recorded: RecordedAnswers): FakeFetch {
  return fake
    .on(youtubeUrls.channel(NASA), { body: recorded.nasaChannel })
    .on(youtubeUrls.videos(NASA), { body: recorded.nasaVideos })
    .on(youtubeUrls.shorts(NASA), { body: recorded.nasaShorts })
    .on(youtubeUrls.lives(NASA), { body: recorded.nasaLives })
    .on(youtubeUrls.page(`channel/${NASA}`), { body: recorded.nasaPage })
    .on(youtubeUrls.page('@NASA'), { body: recorded.nasaPage })
    .on(youtubeUrls.oembed(NASA_VIDEO), { body: recorded.oembedNasa })
    .on(NASA_AVATAR, { body: TINY_JPEG, headers: { 'Content-Type': 'image/jpeg' } })
    .on(youtubeUrls.channel(KURZGESAGT), { body: recorded.kurzgesagtChannel })
    .on(youtubeUrls.videos(KURZGESAGT), { body: recorded.kurzgesagtVideos })
    .on(youtubeUrls.shorts(KURZGESAGT), { body: recorded.kurzgesagtShorts })
    .on(youtubeUrls.lives(KURZGESAGT), { status: 404, body: recorded.kurzgesagtLives })
    .on(youtubeUrls.page(`channel/${KURZGESAGT}`), { status: 404, body: recorded.page404 });
}
