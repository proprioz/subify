import { IonProgressBar } from '@ionic/react';
import { useAppData } from '../app/AppData';
import { useRefreshProgress } from '../ui/refresh-progress';

/**
 * The loading bar of a refresh, at the very top of the screen, over every page: the refresh goes
 * on wherever the user goes, and the bar shows it there. It lives in this component alone, so
 * that its frames do not render the pages again.
 */
export function RefreshBar() {
  const { syncing, syncDone } = useAppData();
  const progress = useRefreshProgress(syncing, syncDone);

  return progress === null ? null : <IonProgressBar className="refresh-bar" value={progress / 100} aria-label="Refreshing feed" />;
}
