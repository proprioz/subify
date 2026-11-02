import { IonBadge, IonButton, IonCard, IonContent, IonIcon, IonItem, IonLabel, IonPopover, IonText, IonThumbnail } from '@ionic/react';
import { eyeOffOutline, helpCircleOutline, openOutline, personCircleOutline } from 'ionicons/icons';
import { useEffect, useState } from 'react';
import type { StoredItem, StoredThumbnail, Subscription } from '../data/db';
import { shortAgeLabel } from '../data/format';
import { keepsThumbnail, THUMBNAIL_DAYS } from '../data/thumbnails';
import { videoLink } from '../data/video-link';
import { copyText, platformName } from '../ui/clipboard';
import { MORE_ICON, SHARE_ICON } from '../ui/icons';
import { useToast } from '../ui/toast';
import { Menu, type MenuAction } from './Menu';

/**
 * Every known kind is marked, so that a card says what it holds at a glance. The mark is a badge
 * with the kind's first letter, so that the line under the title keeps to one line.
 */
const KINDS: Partial<Record<StoredItem['type'], { text: string }>> = {
  video: { text: 'Video' },
  short: { text: 'Short' },
  live: { text: 'Live' },
};

interface Props {
  item: StoredItem;
  channel: Subscription;
  thumbnail?: StoredThumbnail | undefined;
  /** Offers “More from …”, which only makes sense when the feed shows more than this channel. */
  onShowChannel?: ((key: string) => void) | undefined;
}

/**
 * One video. Tapping it copies its link, the app's main action: the user opens it wherever they
 * like; opening it on the platform and sharing it live in the ⋯ menu. Without a kept thumbnail,
 * the placeholder holds a button that says why, since an empty frame looks like a fault.
 */
export function VideoCard({ item, channel, thumbnail, onShowChannel }: Props) {
  const toast = useToast();
  const image = useImage(thumbnail);
  const [menuFrom, setMenuFrom] = useState<Event | null>(null);
  const [helpFrom, setHelpFrom] = useState<Event | null>(null);
  const unavailable = item.deleted === true;
  const kind = KINDS[item.type];
  const link = videoLink(item.url);

  const copy = async () => {
    const copied = link !== null && (await copyText(link));
    navigator.vibrate?.(10);
    await toast(copied ? 'Link copied.' : 'Couldn’t copy the link.', 1500);
  };

  const actions: MenuAction[] = [
    ...(link === null
      ? []
      : [
          { text: `Open in ${platformName(item.key)}`, icon: openOutline, handler: () => void window.open(link, '_blank', 'noopener,noreferrer') },
          ...(typeof navigator.share === 'function'
            ? [{ text: 'Share…', icon: SHARE_ICON, handler: () => void navigator.share({ title: item.title, url: link }).catch(() => {}) }]
            : []),
        ]),
    ...(onShowChannel !== undefined ? [{ text: `More from ${channel.title}`, icon: personCircleOutline, handler: () => onShowChannel(channel.key) }] : []),
  ];

  // The popovers sit beside the card, not in it: the card's CSS containment would clip them.
  return (
    <>
      <IonCard className="video-card">
        <IonItem
          button={!unavailable}
          detail={false}
          lines="none"
          className={unavailable ? 'video-unavailable' : ''}
          onClick={unavailable ? undefined : () => void copy()}
          aria-label={unavailable ? undefined : `Copy link to ${kind === undefined ? '' : `${kind.text}: `}${item.title}`}
        >
          <IonThumbnail slot="start" className="video-thumbnail ion-display-flex ion-align-items-center ion-justify-content-center">
            {/* Said by the channel's mark below; this one is for the eye, while scrolling. */}
            {channel.secret && (
              <span className="secret-tag" aria-hidden="true">
                <IonIcon icon={eyeOffOutline} />
                Secret
              </span>
            )}
            {image !== null ? (
              <img src={image} alt="" />
            ) : (
              !unavailable && (
                <IonButton
                  fill="clear"
                  color="medium"
                  size="large"
                  aria-label="Why there’s no thumbnail"
                  onClick={(event) => {
                    event.stopPropagation();
                    setHelpFrom(event.nativeEvent);
                  }}
                >
                  <IonIcon slot="icon-only" icon={helpCircleOutline} />
                </IonButton>
              )
            )}
          </IonThumbnail>
          <IonLabel className="ion-text-wrap">
            <h3>{item.title}</h3>
            {/* One line, which never wraps: the channel's name is cut short before the date. */}
            <p className="video-meta">
              {kind !== undefined && (
                <IonBadge className={`kind-${item.type}`} role="img" aria-label={kind.text}>
                  {kind.text[0]}
                </IonBadge>
              )}
              {unavailable ? (
                <span className="video-channel">Unavailable</span>
              ) : (
                <>
                  <span className="video-channel">
                    {channel.secret && <IonIcon icon={eyeOffOutline} className="secret-mark" aria-label="Secret channel" />}
                    {channel.title}
                  </span>
                  {/* Its date is when it was scheduled, which says nothing of when it starts. */}
                  <span>{` · ${item.upcoming === 1 ? 'Upcoming' : shortAgeLabel(item.published)}`}</span>
                </>
              )}
            </p>
          </IonLabel>
          {!unavailable && (
            <IonButton
              slot="end"
              fill="clear"
              color="medium"
              aria-label={`More actions for ${item.title}`}
              onClick={(event) => {
                event.stopPropagation();
                setMenuFrom(event.nativeEvent);
              }}
            >
              <IonIcon slot="icon-only" {...MORE_ICON} />
            </IonButton>
          )}
        </IonItem>
      </IonCard>
      <Menu from={menuFrom} onClose={() => setMenuFrom(null)} actions={actions} />
      <IonPopover isOpen={helpFrom !== null} event={helpFrom ?? undefined} onDidDismiss={() => setHelpFrom(null)}>
        <IonContent className="ion-padding">
          <IonText>
            <p className="ion-no-margin">{missingThumbnailReason(item, thumbnail)}</p>
          </IonText>
        </IonContent>
      </IonPopover>
    </>
  );
}

/**
 * Why the card shows no thumbnail, in the order the cases are told apart: the platform said it
 * has none, the video is older than what the device keeps, or it was not downloaded yet.
 */
function missingThumbnailReason(item: StoredItem, thumbnail: StoredThumbnail | undefined): string {
  if (thumbnail !== undefined && thumbnail.data === null) {
    return 'The platform has no thumbnail for this video.';
  }

  if (!keepsThumbnail(item)) {
    return `To save space, the app keeps thumbnails for the last ${THUMBNAIL_DAYS} days only.`;
  }

  return 'No thumbnail: the app gets them only for a channel’s last 7 days, when you add it.';
}

/** The kept thumbnail as an object URL, released when the card no longer shows it. */
function useImage(thumbnail: StoredThumbnail | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const data = thumbnail?.data ?? null;
  const type = thumbnail?.type ?? null;

  useEffect(() => {
    if (data === null || type === null) {
      setUrl(null);

      return;
    }

    const objectUrl = URL.createObjectURL(new Blob([data], { type }));
    setUrl(objectUrl);

    return () => URL.revokeObjectURL(objectUrl);
  }, [data, type]);

  return url;
}
