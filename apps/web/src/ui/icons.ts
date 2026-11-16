import { ellipsisHorizontal, ellipsisVertical, shareOutline, shareSocialOutline } from 'ionicons/icons';

/** An icon drawn differently per platform, spread onto IonIcon: Ionic picks the one for its mode. */
export interface PlatformIcon {
  ios: string;
  md: string;
}

/** “More”: three dots across on iOS, down on Android. */
export const MORE_ICON: PlatformIcon = { ios: ellipsisHorizontal, md: ellipsisVertical };

/**
 * A secret: the closed eye of Subify's logo, its lashes down (favicon.svg), in the
 * text's colour. It stands for everything secret in the app: the banner, the menus, Settings, and the
 * marks on secret channels' avatars and videos.
 */
export const SECRET_ICON =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='6 6 52 52' class='ionicon'><g transform='translate(0 -6)' class='ionicon-fill-none' stroke-width='5' stroke-linecap='round'><path d='M10 28Q32 50 54 28'/><path d='M15.3 32.6l-5.3 9'/><path d='M23.6 37.4l-2.7 9'/><path d='M32 39v9'/><path d='M40.4 37.4l2.7 9'/><path d='M48.7 32.6l5.3 9'/></g></svg>";

/** Share: iOS's box and arrow, Android's three linked dots. */
export const SHARE_ICON: PlatformIcon = { ios: shareOutline, md: shareSocialOutline };
