import { IonProgressBar } from '@ionic/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAppData } from '../app/AppData';
import { loadLiquidRefreshBar } from '../data/settings';
import { useRefreshProgress } from '../ui/refresh-progress';

/**
 * The loading bar of a refresh, at the very top of the screen, over every page: the refresh goes
 * on wherever the user goes, and the bar shows it there. It lives in this component alone, so
 * that its frames do not render the pages again.
 *
 * Turned on in Settings, it looks like liquid where it fills the status bar: Lucas Bebber's gooey
 * effect (CSS-Tricks, 2015), a blur then an alpha threshold that merge the fill with the drops at
 * its front.
 */
export function RefreshBar() {
  const { db, syncing, syncDone } = useAppData();
  const progress = useRefreshProgress(syncing, syncDone);
  const liquid = useLiveQuery(() => loadLiquidRefreshBar(db), [db]) ?? false;

  if (progress === null) {
    return null;
  }

  if (!liquid) {
    return <IonProgressBar className="refresh-bar" value={progress / 100} aria-label="Refreshing feed" />;
  }

  return (
    <div className="refresh-bar" role="progressbar" aria-label="Refreshing feed" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
      <svg aria-hidden="true">
        <filter id="refresh-goo">
          <feGaussianBlur stdDeviation="6" />
          <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" />
        </filter>
        <g className="refresh-liquid">
          {/* Beyond the top and left of the screen, so that the blur rounds only the front and the bottom. */}
          <rect x="-20" y="-20" width="20" height="200%" />
          <rect y="-20" width={`${progress}%`} height="20" />
          <rect width={`${progress}%`} height="100%" />
          {progress < 100 && (
            <svg x={`${progress}%`} overflow="visible">
              <circle className="refresh-drop" cy="23%" r="9" />
              <circle className="refresh-drop" cy="48%" r="9" />
              <circle className="refresh-drop" cy="74%" r="9" />
            </svg>
          )}
        </g>
      </svg>
    </div>
  );
}
