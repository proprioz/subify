/** The URLs the YouTube adapter reads, as tests register them. */
export const youtubeUrls = {
  channel: (id: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,
  videos: (id: string) => `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${id.slice(2)}`,
  shorts: (id: string) => `https://www.youtube.com/feeds/videos.xml?playlist_id=UUSH${id.slice(2)}`,
  lives: (id: string) => `https://www.youtube.com/feeds/videos.xml?playlist_id=UULV${id.slice(2)}`,
  page: (path: string) => `https://www.youtube.com/${path}`,
  oembed: (videoId: string) =>
    `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
  smallThumbnail: (videoId: string) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
};
