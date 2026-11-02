/**
 * Real YouTube responses, recorded by scripts/record-fixtures.ts. See that script for what each
 * channel was picked for.
 */
import channelFeed404 from './channel-feed-404.html?raw';
import kurzgesagtChannel from './kurzgesagt-channel.xml?raw';
import kurzgesagtLives from './kurzgesagt-lives.html?raw';
import kurzgesagtShorts from './kurzgesagt-shorts.xml?raw';
import kurzgesagtVideos from './kurzgesagt-videos.xml?raw';
import nasaChannel from './nasa-channel.xml?raw';
import nasaLives from './nasa-lives.xml?raw';
import nasaPage from './nasa-page.html?raw';
import nasaShorts from './nasa-shorts.xml?raw';
import nasaVideos from './nasa-videos.xml?raw';
import oembed404 from './oembed-404.txt?raw';
import oembedNasa from './oembed-nasa.json?raw';
import page404 from './page-404.html?raw';

export { KURZGESAGT, NASA, NASA_AVATAR, NASA_VIDEO, TINY_JPEG } from './ids';

export const fixtures = {
  channelFeed404,
  kurzgesagtChannel,
  kurzgesagtLives,
  kurzgesagtShorts,
  kurzgesagtVideos,
  nasaChannel,
  nasaLives,
  nasaPage,
  nasaShorts,
  nasaVideos,
  oembed404,
  oembedNasa,
  page404,
};
