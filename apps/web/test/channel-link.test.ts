import { describe, expect, it } from 'vitest';
import { isChannelInput, isChannelName, localChannelKey } from '../src/data/channel-link';

const ID = 'UCLA_DiR1FfKNvjuUpBHmylQ';

// Imports read their links on the device: a link read wrongly loses a channel or follows the wrong one.
describe('reading a channel link on the device', () => {
  it.each([
    ID,
    `https://www.youtube.com/channel/${ID}`,
    `https://m.youtube.com/channel/${ID}/videos?view=0#top`,
    `youtube.com/channel/${ID}/`,
    `https://www.youtube.com/feeds/videos.xml?channel_id=${ID}`,
  ])('finds the channel in %s', (input) => {
    expect(localChannelKey(input)).toBe(`youtube:${ID}`);
  });

  it.each([
    '@NASA',
    'https://www.youtube.com/@NASA',
    'https://www.youtube.com/watch?v=UleiRdWFG7o',
    `http://www.youtube.com/channel/${ID}`,
    `https://example.com/channel/${ID}`,
    'https://www.youtube.com/channel/UC123',
  ])('leaves %s to the server', (input) => {
    expect(localChannelKey(input)).toBeNull();
  });
});

// Enter looks up only what names a channel: a name typed to filter the list, then Enter, must never be sent to the server.
describe('telling a channel to add from a search', () => {
  it.each(['@NASA', '@hugodécrypte', ID, 'https://www.youtube.com/@NASA', 'youtube.com/channel/' + ID, 'https://youtu.be/UleiRdWFG7o', ' m.youtube.com/watch?v=UleiRdWFG7o '])(
    'offers to add %s',
    (input) => {
      expect(isChannelInput(input)).toBe(true);
    },
  );

  it.each(['NASA', 'Mr.Beast', 'Kurzgesagt – In a Nutshell', '@', '@ab', '@NASA videos', 'example.com/@NASA', 'https://www.youtube.com.evil.example/@NASA'])(
    'only searches the list for %s',
    (input) => {
      expect(isChannelInput(input)).toBe(false);
    },
  );
});

// A name is offered for looking up from its button, but a link to another site must never be offered as one.
describe('telling a channel name from a search', () => {
  it.each(['NASA', 'Léna Situations', '@Léna Situations', 'Mr.Beast'])('offers to look up %s by its name', (input) => {
    expect(isChannelName(input)).toBe(true);
  });

  it.each(['@NASA', 'https://www.youtube.com/@NASA', 'example.com/@NASA', 'https://example.com', 'ab', '@'])('does not take %s for a name', (input) => {
    expect(isChannelName(input)).toBe(false);
  });
});
