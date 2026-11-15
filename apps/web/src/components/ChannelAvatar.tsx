import { IonAvatar } from '@ionic/react';
import { blurredPicture } from '../ui/blurred-picture';

/**
 * The channel's avatar, as the server sent it with the channel (a data: URL: nothing is loaded),
 * or its initials while there is none, over a blurred picture drawn from the channel's key: each
 * channel has its own, always the same, before it is followed as after.
 */
export function ChannelAvatar({ channel, title, avatar = null, slot }: { channel: string; title: string; avatar?: string | null; slot?: string }) {
  const initials = title
    .split(/\s+/)
    .filter((word) => /^[\p{L}\p{N}]/u.test(word))
    .slice(0, 2)
    .map((word) => [...word][0]?.toLocaleUpperCase() ?? '')
    .join('');

  // Only a data: URL is shown: an image from anywhere else would go online.
  if (avatar?.startsWith('data:image/') === true) {
    return (
      <IonAvatar slot={slot} aria-hidden="true">
        <img src={avatar} alt="" />
      </IonAvatar>
    );
  }

  return (
    <IonAvatar
      slot={slot}
      className="blurred ion-display-flex ion-align-items-center ion-justify-content-center"
      style={{ background: blurredPicture(channel) }}
      aria-hidden="true"
    >
      <span>{initials || '?'}</span>
    </IonAvatar>
  );
}
