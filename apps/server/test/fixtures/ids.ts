export const NASA = 'UCLA_DiR1FfKNvjuUpBHmylQ';
export const KURZGESAGT = 'UCsXVk37bltHxD1rDPwtNM8Q';
/** A NASA video whose oEmbed answer was recorded. */
export const NASA_VIDEO = 'UleiRdWFG7o';
/** NASA's avatar at the size the server reads, from the og:image of the recorded page. */
export const NASA_AVATAR = 'https://yt3.googleusercontent.com/eIf5fNPcIcj9ig-wZBeq4stFy1lgjWTW1nLT5dYlFkHZprZ03QBiMcbpwNMB6XSBjrSFGtAGQg=s88-c-k-c0x00ffffff-no-rj';

/**
 * A made-up 1×1 JPEG standing in for avatars and thumbnails: the server only checks an image's
 * type and size, never what it shows. Not recorded, so no test depends on YouTube's pictures.
 */
export const TINY_JPEG = Uint8Array.from(
  atob('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='),
  (char) => char.charCodeAt(0),
);
