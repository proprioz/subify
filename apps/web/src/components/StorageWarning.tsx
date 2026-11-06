import { useIonToast } from '@ionic/react';
import { close } from 'ionicons/icons';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { installCardDue, loadInstallCard } from '../data/settings';
import { takeStorageWarning } from '../data/storage-warning';
import { canInstall } from '../ui/install';
import { toastPlacement } from '../ui/toast';
import { useInstallFlow } from './InstallGuide';

/** Leaves the page time to show, and the browser time to offer its install dialog. */
const DELAY = 1500;

/**
 * As the app opens, a toast warns once that the browser may clear the channels, when nothing keeps
 * them: no install, no promise from the browser, no backup of the latest ones. It leaves the
 * screen on its own; the feed's invitation to install, when it shows, already says it.
 */
export function StorageWarning() {
  const { db, install, storageKept } = useAppData();
  const navigate = useNavigate();
  const [present] = useIonToast();
  const installFlow = useInstallFlow(() => navigate('/settings?backup=install'));
  const latest = useRef({ install, start: installFlow.start });
  latest.current = { install, start: installFlow.start };
  const checked = useRef(false);

  useEffect(() => {
    if (storageKept === undefined || checked.current) {
      return;
    }

    const timer = setTimeout(() => {
      checked.current = true;
      void (async () => {
        const { install: state, start } = latest.current;
        const now = Date.now();
        const cardShown = canInstall(state) && installCardDue(await loadInstallCard(db), now) && window.location.pathname.startsWith('/feed');

        if (state === 'installed' || cardShown || !(await takeStorageWarning(db, !storageKept, now))) {
          return;
        }

        await present({
          message: `Careful: this browser may clear your channels one day. ${canInstall(state) ? 'Install the app or save a backup' : 'Save a backup'} to keep them.`,
          duration: 8000,
          ...toastPlacement(),
          buttons: [
            canInstall(state) ? { text: 'Install', handler: start } : { text: 'Back up', handler: () => navigate('/settings?backup=1') },
            { icon: close, role: 'cancel', htmlAttributes: { 'aria-label': 'Close' } },
          ],
        });
      })();
    }, DELAY);

    return () => clearTimeout(timer);
  }, [db, storageKept, present, navigate]);

  return installFlow.guide;
}
