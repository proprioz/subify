/**
 * Copies text from a tap. The Clipboard API needs a secure context and sometimes refuses in
 * installed PWAs; the hidden textarea is the fallback that works everywhere. From an open Ionic
 * overlay, the textarea goes inside its `.ion-overlay-wrapper`: the overlay takes the focus back
 * from anything outside it, and the textarea would copy nothing.
 */
export async function copyText(text: string, within: HTMLElement = document.body): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'copy-buffer';
    within.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();

    return copied;
  }
}

/** The platform an item or channel key belongs to, for labels such as “Open in YouTube”. */
export function platformName(key: string): string {
  return key.startsWith('youtube:') ? 'YouTube' : 'the platform';
}
