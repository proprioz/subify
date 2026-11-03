import { IonAvatar, IonIcon } from '@ionic/react';
import { eyeOffOutline } from 'ionicons/icons';
import { blurredPicture } from '../ui/blurred-picture';

/**
 * The channel's avatar, as the server sent it with the channel (a data: URL: nothing is loaded),
 * or its initials while there is none, over a blurred picture drawn from the channel's key: each
 * channel has its own, always the same, before it is followed as after. A secret channel's carries an eye-off badge in its corner;
 * whoever shows the avatar says “secret” to screen readers, as the avatar is hidden from them.
 */
export function ChannelAvatar({ channel, title, avatar = null, slot, secret = false }: { channel: string; title: string; avatar?: string | null; slot?: string; secret?: boolean }) {
  const badge = secret && <IonIcon icon={eyeOffOutline} className="secret-badge" />;

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
        {badge}
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
      {badge}
    </IonAvatar>
  );
}
