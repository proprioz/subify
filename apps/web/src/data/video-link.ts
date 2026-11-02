/**
 * A video's link as the app may open, copy or share it: an https URL, or null. The server builds
 * these links itself; checking them here keeps a damaged or hostile answer from handing the app a
 * javascript: URL to open.
 */
export function videoLink(url: string): string | null {
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
