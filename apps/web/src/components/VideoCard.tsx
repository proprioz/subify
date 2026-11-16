import {
  IonBadge,
  IonButton,
  IonCard,
  IonContent,
  IonIcon,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonLabel,
  IonPopover,
  IonText,
  IonThumbnail,
  useIonActionSheet,
} from '@ionic/react';
import { cloudDownloadOutline, compassOutline, copyOutline, helpCircleOutline, openOutline, personCircleOutline } from 'ionicons/icons';
import { type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { thumbHashToDataURL } from 'thumbhash';
import type { StoredItem, StoredThumbnail, Subscription } from '../data/db';
import { shortAgeLabel } from '../data/format';
import type { VideoTap } from '../data/settings';
import { keepsThumbnail, THUMBNAIL_KEEP_CHOICES, type ThumbnailKeep, thumbnailMayCome } from '../data/thumbnails';
import { videoLink } from '../data/video-link';
import { blurredPicture, type Hsl } from '../ui/blurred-picture';
import { copyText, platformName } from '../ui/clipboard';
import { MORE_ICON, type PlatformIcon, SECRET_ICON, SHARE_ICON } from '../ui/icons';
import { openVideo, openVideoUrl, thisDevice } from '../ui/open-video';
import { shortFill } from '../ui/short-fill';
import { useToast } from '../ui/toast';

/** How long a touch on a card lasts before it offers the card's actions, and how far it may move. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

/** One of a card's actions: `text` in its sheet, `short` under its icon where swiping reveals it. */
interface CardAction {
  text: string;
  short: string;
  icon: string | PlatformIcon;
  handler(): void;
}

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
  /** How long the device keeps thumbnails (Settings), to say why an older video has none. */
  thumbnailKeep: ThumbnailKeep;
  /** What tapping the card does (Settings). */
  tap: VideoTap;
  /** Offers “More from …”, which only makes sense when the feed shows more than this channel. */
  onShowChannel?: ((key: string) => void) | undefined;
}

/**
 * One video. Tapping it opens it in the platform's app, opens it in the browser or copies its link,
 * as the user chose in Settings. Its other actions (the two other ways to open it, sharing, its
 * channel's videos) show in a sheet, which touching and holding the card, right-clicking it or its ⋯
 * opens, and as buttons that swiping the card reveals. Touch screens show no ⋯: it stays for screen
 * readers and keyboards only (theme.css). Until its thumbnail comes, the card shows the blurred
 * preview the stream gave (its ThumbHash, docs/FEATURES.md, D3) with a mark that says it is on its
 * way, and the thumbnail then fades in. Without either, the placeholder holds a button that says
 * why, since an empty frame looks like a fault.
 */
export function VideoCard({ item, channel, thumbnail, thumbnailKeep, tap, onShowChannel }: Props) {
  const toast = useToast();
  const image = useImage(thumbnail);
  const fill = useShortFill(item, image);
  const short = item.type === 'short' && image !== null;
  const preview = usePreview(item.preview);
  const kept = (thumbnail?.data ?? null) !== null;
  const coming = !kept && preview !== null && thumbnailMayCome(item);
  // Fades in only a thumbnail that arrived while the card was showing: not every card as it mounts.
  const waited = useRef(false);
  useEffect(() => {
    waited.current ||= coming;
  }, [coming]);
  const fadeIn = waited.current && image !== null;
  const [presentSheet] = useIonActionSheet();
  const sliding = useRef<HTMLIonItemSlidingElement>(null);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  // Set once a long press opened the sheet, so that lifting the finger doesn't open the video too.
  const pressed = useRef(false);
  const openAtPress = useRef(false);
  useEffect(
    () => () => {
      if (press.current !== null) {
        clearTimeout(press.current.timer);
      }
    },
    [],
  );
  const [helpFrom, setHelpFrom] = useState<Event | null>(null);
  const unavailable = item.deleted === true;
  const kind = KINDS[item.type];
  const link = videoLink(item.url);

  const copy = async () => {
    const copied = link !== null && (await copyText(link));
    navigator.vibrate?.(10);
    await toast(copied ? 'Link copied.' : 'Couldn’t copy the link.', 1500);
  };

  const open: Record<VideoTap, CardAction> = {
    app: { text: `Open in ${platformName(item.key)}`, short: platformName(item.key), icon: openOutline, handler: () => link !== null && openVideo(link, 'app', item.key) },
    browser: { text: 'Open in the browser', short: 'Browser', icon: compassOutline, handler: () => link !== null && openVideo(link, 'browser', item.key) },
    copy: { text: 'Copy link', short: 'Copy link', icon: copyOutline, handler: () => void copy() },
  };
  // On a computer, or where the app can't name the browser, both open the same link: they count as one.
  const device = thisDevice();
  const sameOpening = link !== null && openVideoUrl(link, 'app', item.key, device) === openVideoUrl(link, 'browser', item.key, device);
  const opening = (choice: VideoTap) => (sameOpening && choice === 'browser' ? 'app' : choice);
  const others = (['copy', 'app', 'browser'] as const).filter((choice) => opening(choice) !== opening(tap) && !(sameOpening && choice === 'browser'));

  const actions: CardAction[] = [
    ...(link === null
      ? []
      : [
          ...others.map((choice) => open[choice]),
          ...(typeof navigator.share === 'function'
            ? [{ text: 'Share…', short: 'Share', icon: SHARE_ICON, handler: () => void navigator.share({ title: item.title, url: link }).catch(() => {}) }]
            : []),
        ]),
    ...(onShowChannel !== undefined
      ? [{ text: `More from ${channel.title}`, short: 'More from', icon: personCircleOutline, handler: () => onShowChannel(channel.key) }]
      : []),
  ];
  const offersActions = !unavailable && actions.length > 0;

  const showActions = () => {
    void sliding.current?.close();
    void presentSheet({
      header: item.title,
      subHeader: channel.title,
      buttons: [...actions.map(({ text, handler }) => ({ text, handler })), { text: 'Cancel', role: 'cancel' }],
    });
  };

  const endPress = () => {
    if (press.current !== null) {
      clearTimeout(press.current.timer);
      press.current = null;
    }
  };

  // Android also reports a long touch as a right click: whichever comes first opens the sheet.
  const longPress = () => {
    endPress();

    if (!pressed.current) {
      pressed.current = true;
      navigator.vibrate?.(10);
      showActions();
    }
  };

  const startPress = (event: PointerEvent) => {
    pressed.current = false;
    endPress();

    // A mouse has its right click. Safari on iOS reports no long touch, so the card times it.
    if (offersActions && event.pointerType !== 'mouse') {
      press.current = { timer: window.setTimeout(longPress, LONG_PRESS_MS), x: event.clientX, y: event.clientY };
    }
  };

  // Scrolling or swiping is no long press.
  const movePress = (event: PointerEvent) => {
    if (press.current !== null && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > LONG_PRESS_SLOP) {
      endPress();
    }
  };

  // The help popover sits beside the card, not in it: the card's CSS containment would clip it.
  return (
    <>
      <IonCard className={channel.secret ? 'video-card video-secret' : 'video-card'}>
        <IonItemSliding
          ref={sliding}
          disabled={!offersActions}
          // While the actions show, the card takes no tap: a tap beside them closes them. Not the click
          // that ends a mouse's drag, which opened them.
          onPointerDownCapture={() => {
            openAtPress.current = sliding.current?.classList.contains('item-sliding-active-options-end') ?? false;
          }}
          onClick={(event) => {
            if (openAtPress.current && (event.target as Element).closest('ion-item-option') === null) {
              void sliding.current?.close();
            }
          }}
        >
          <IonItem
            button={!unavailable}
            detail={false}
            lines="none"
            className={unavailable ? 'video-unavailable' : ''}
            onClick={
              unavailable
                ? undefined
                : () => {
                    if (pressed.current) {
                      pressed.current = false;
                    } else {
                      open[tap].handler();
                    }
                  }
            }
            onPointerDown={startPress}
            onPointerMove={movePress}
            onPointerUp={endPress}
            onPointerCancel={endPress}
            onContextMenu={(event) => {
              if (offersActions) {
                event.preventDefault();
                longPress();
              }
            }}
            // A secret channel's card only shows it by its grey and its badge: the name says it to screen readers.
            aria-label={unavailable ? undefined : `${open[tap].text}: ${kind === undefined ? '' : `${kind.text}, `}${item.title}${channel.secret ? ', secret channel' : ''}`}
          >
            <IonThumbnail
              slot="start"
              className={`video-thumbnail ion-display-flex ion-align-items-center ion-justify-content-center${image === null ? ' blurred' : short ? ' short-thumbnail' : ''}`}
              style={
                image === null
                  ? { background: preview === null ? blurredPicture(item.key) : `center / cover no-repeat url(${preview})` }
                  : short
                    ? { background: blurredPicture(item.key, fill ?? GREY) }
                    : undefined
              }
            >
              {image !== null ? (
                <img src={image} alt="" {...(fadeIn ? { className: 'fade-in' } : {})} />
              ) : (
                !unavailable && (
                  <IonButton
                    fill="clear"
                    size={coming ? 'small' : 'large'}
                    {...(coming ? { className: 'thumbnail-coming' } : {})}
                    aria-label={coming ? 'Thumbnail on its way' : 'Why there’s no thumbnail'}
                    onClick={(event) => {
                      event.stopPropagation();
                      setHelpFrom(event.nativeEvent);
                    }}
                  >
                    <IonIcon slot="icon-only" icon={coming ? cloudDownloadOutline : helpCircleOutline} />
                  </IonButton>
                )
              )}
              {channel.secret && <IonIcon icon={SECRET_ICON} className="thumbnail-secret" aria-hidden="true" />}
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
                      {channel.title}
                    </span>
                    {/* Its date is when it was scheduled, which says nothing of when it starts. */}
                    <span>{` · ${item.upcoming === 1 ? 'Upcoming' : shortAgeLabel(item.published)}`}</span>
                  </>
                )}
                {offersActions && (
                  <IonButton
                    fill="clear"
                    size="small"
                    color="medium"
                    className="video-more"
                    aria-label={`More actions for ${item.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      showActions();
                    }}
                  >
                    <IonIcon slot="icon-only" {...MORE_ICON} />
                  </IonButton>
                )}
              </p>
            </IonLabel>
          </IonItem>
          {offersActions && (
            <IonItemOptions side="end">
              {actions.map((action) => (
                <IonItemOption
                  key={action.text}
                  color="medium"
                  onClick={() => {
                    void sliding.current?.close();
                    action.handler();
                  }}
                >
                  <IonIcon slot="top" {...(typeof action.icon === 'string' ? { icon: action.icon } : action.icon)} aria-hidden="true" />
                  {action.short}
                </IonItemOption>
              ))}
            </IonItemOptions>
          )}
        </IonItemSliding>
      </IonCard>
      <IonPopover className="info-popover" isOpen={helpFrom !== null} event={helpFrom ?? undefined} onDidDismiss={() => setHelpFrom(null)}>
        <IonContent className="ion-padding">
          <IonText>
            <p className="ion-no-margin">{coming ? 'The thumbnail is on its way: a refresh brings it, usually within an hour of the video.' : missingThumbnailReason(item, thumbnail, thumbnailKeep)}</p>
          </IonText>
        </IonContent>
      </IonPopover>
    </>
  );
}

/**
 * Why the card shows no thumbnail, in the order the cases are told apart: the platform said it
 * has none, the video is older than what the device keeps, or it was not downloaded or deleted.
 */
function missingThumbnailReason(item: StoredItem, thumbnail: StoredThumbnail | undefined, keep: ThumbnailKeep): string {
  if (thumbnail !== undefined && thumbnail.data === null) {
    return 'The platform has no thumbnail for this video.';
  }

  if (!keepsThumbnail(item, keep)) {
    const time = THUMBNAIL_KEEP_CHOICES.find((choice) => choice.value === keep)!.label.replace(/^1 /, '');

    return `To save space, the app keeps thumbnails for the last ${time} only. You can change this in Settings.`;
  }

  return 'No thumbnail: the app gets them with a refresh, for the videos of the last 7 days, and one deleted to save space doesn’t come back.';
}

/** A Short's fill until its main colour is known: no colour of its own, rather than a wrong one. */
const GREY: Hsl = { hue: 0, saturation: 0, lightness: 50 };

/** A Short's main colour, once its thumbnail is read; null for any other item, or until then. */
function useShortFill(item: StoredItem, image: string | null): Hsl | null {
  const [fill, setFill] = useState<Hsl | null>(null);
  const short = item.type === 'short';

  useEffect(() => {
    setFill(null);

    if (!short || image === null) {
      return;
    }

    let current = true;
    void shortFill(item.key, image).then((color) => current && setFill(color));

    return () => {
      current = false;
    };
  }, [short, item.key, image]);

  return fill;
}

/** The blurred preview the stream gave, as a data: URL drawn on the device; null without one. */
function usePreview(hash: Uint8Array | undefined): string | null {
  return useMemo(() => {
    if (hash === undefined) {
      return null;
    }

    try {
      return thumbHashToDataURL(hash);
    } catch {
      return null;
    }
  }, [hash]);
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
