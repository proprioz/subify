import { describe, expect, it } from 'vitest';
import { InputError } from '../../src/sources/source';
import { typedPlaylistId } from '../../src/sources/youtube/ids';
import { guessHandles, parseYoutubeInput } from '../../src/sources/youtube/input';

const ID = 'UCLA_DiR1FfKNvjuUpBHmylQ';

// A link form that is not recognized blocks the subscription, or creates a duplicate channel.
describe('reading what the user pasted', () => {
  it.each([
    [ID, { kind: 'channel', externalId: ID }],
    [`https://www.youtube.com/channel/${ID}`, { kind: 'channel', externalId: ID }],
    [`https://www.youtube.com/channel/${ID}/`, { kind: 'channel', externalId: ID }],
    [`https://www.youtube.com/channel/${ID}/videos?view=0&sort=dd#top`, { kind: 'channel', externalId: ID }],
    [`https://m.youtube.com/channel/${ID}`, { kind: 'channel', externalId: ID }],
    [`youtube.com/channel/${ID}`, { kind: 'channel', externalId: ID }],
    [`  https://WWW.YouTube.com/channel/${ID}  `, { kind: 'channel', externalId: ID }],
    [`https://www.youtube.com/feeds/videos.xml?channel_id=${ID}`, { kind: 'channel', externalId: ID }],
    [`https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${ID.slice(2)}`, { kind: 'channel', externalId: ID }],
    ['@NASA', { kind: 'handle', handle: 'NASA' }],
    ['https://www.youtube.com/@NASA', { kind: 'handle', handle: 'NASA' }],
    ['https://m.youtube.com/@NASA/videos', { kind: 'handle', handle: 'NASA' }],
    ['https://www.youtube.com/@caf%C3%A9.cr%C3%A8me', { kind: 'handle', handle: 'café.crème' }],
    ['https://www.youtube.com/c/NASA', { kind: 'other', value: 'c:NASA' }],
    ['https://www.youtube.com/user/NASAtelevision/', { kind: 'other', value: 'user:NASAtelevision' }],
    ['https://www.youtube.com/watch?v=UleiRdWFG7o&t=42s', { kind: 'other', value: 'video:UleiRdWFG7o' }],
    ['https://youtu.be/UleiRdWFG7o?si=abc', { kind: 'other', value: 'video:UleiRdWFG7o' }],
    ['https://www.youtube.com/shorts/-62C9R_41Sc', { kind: 'other', value: 'video:-62C9R_41Sc' }],
    ['https://m.youtube.com/live/UleiRdWFG7o', { kind: 'other', value: 'video:UleiRdWFG7o' }],
  ])('reads %s', (input, expected) => {
    expect(parseYoutubeInput(input)).toEqual(expected);
  });

  it('leaves links to other sites to other platforms', () => {
    expect(parseYoutubeInput('https://example.com/channel/' + ID)).toBeNull();
    expect(parseYoutubeInput('https://www.youtube.com.example.com/channel/' + ID)).toBeNull();
    expect(parseYoutubeInput('NASA')).toBeNull();
  });
});

// /submit is the only door through which an outside URL enters the server: anything loose would make it an open proxy.
describe('refusing links the server must not follow', () => {
  it.each([
    ['plain http', `http://www.youtube.com/channel/${ID}`],
    ['another scheme', `ftp://www.youtube.com/channel/${ID}`],
    ['credentials', `https://user:secret@www.youtube.com/channel/${ID}`],
    ['a port', `https://www.youtube.com:8443/channel/${ID}`],
    ['a channel id too short', 'https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmyl'],
    ['a channel id with a bad character', 'https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmyl$'],
    ['a handle with a slash in it', 'https://www.youtube.com/@NA%2FSA'],
    ['a page that is not a channel', 'https://www.youtube.com/results?search_query=nasa'],
    ['several links', `https://www.youtube.com/@NASA https://www.youtube.com/channel/${ID}`],
    ['an empty input', '   '],
  ])('refuses %s', (_, input) => {
    expect(() => parseYoutubeInput(input)).toThrow(InputError);
  });
});

// A name typed instead of a @handle finds the channel only if its handle is among the guesses, and a link must never be taken for a name.
describe('guessing handles from a name', () => {
  it.each([
    ['Léna Situations', ['lenasituations', 'lena.situations', 'lena_situations', 'lena-situations', 'lénasituations']],
    ['@Hugo Décrypte', ['hugodecrypte', 'hugo.decrypte', 'hugo_decrypte', 'hugo-decrypte', 'hugodécrypte']],
    ['lenasituations', ['lenasituations']],
    ['Mr.Beast', ['mrbeast', 'mr.beast', 'mr_beast', 'mr-beast']],
    ["L'Effet Papillon", ['leffetpapillon', 'leffet.papillon', 'leffet_papillon', 'leffet-papillon']],
    ['Kurzgesagt – In a Nutshell', ['kurzgesagtinanutshell', 'kurzgesagt.in.a.nutshell', 'kurzgesagt_in_a_nutshell', 'kurzgesagt-in-a-nutshell']],
  ])('guesses %s', (name, expected) => {
    expect(parseYoutubeInput(name)).toBeNull();
    expect(guessHandles(name)).toEqual(expected);
  });

  it.each(['https://example.com/channel/' + ID, 'example.com/@NASA', 'NASA videos https://youtu.be/UleiRdWFG7o', 'ab', '!!!'])('guesses nothing for %s', (input) => {
    expect(guessHandles(input)).toEqual([]);
  });
});

// A wrong prefix silently breaks every type filter in the app.
describe('typed playlists', () => {
  it('derives each playlist id from the channel id', () => {
    expect(typedPlaylistId(ID, 'video')).toBe('UULFLA_DiR1FfKNvjuUpBHmylQ');
    expect(typedPlaylistId(ID, 'short')).toBe('UUSHLA_DiR1FfKNvjuUpBHmylQ');
    expect(typedPlaylistId(ID, 'live')).toBe('UULVLA_DiR1FfKNvjuUpBHmylQ');
  });
});
