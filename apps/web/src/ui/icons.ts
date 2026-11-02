import { ellipsisHorizontal, ellipsisVertical, shareOutline, shareSocialOutline } from 'ionicons/icons';

/** An icon drawn differently per platform, spread onto IonIcon: Ionic picks the one for its mode. */
export interface PlatformIcon {
  ios: string;
  md: string;
}

/** “More”: three dots across on iOS, down on Android. */
export const MORE_ICON: PlatformIcon = { ios: ellipsisHorizontal, md: ellipsisVertical };

/** Share: iOS's box and arrow, Android's three linked dots. */
export const SHARE_ICON: PlatformIcon = { ios: shareOutline, md: shareSocialOutline };
