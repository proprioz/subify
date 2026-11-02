import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ellipsisHorizontal, ellipsisVertical, shareOutline } from 'ionicons/icons';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useAppData } from '../app/AppData';
import { canInstall, type InstallGuide, startsEmptyOnceInstalled } from '../ui/install';

const GUIDES: Record<InstallGuide, { label: string; steps: ReactNode[] }> = {
  'ios-safari': {
    label: 'Safari on iPhone or iPad',
    steps: [
      <>
        Tap Share <IonIcon icon={shareOutline} aria-hidden="true" />. If you don’t see it, tap <IonIcon icon={ellipsisHorizontal} aria-hidden="true" /> first.
      </>,
      'Scroll down and tap “Add to Home Screen”.',
      'Tap Add, then open Subify from your Home Screen.',
    ],
  },
  'ios-other': {
    label: 'Another browser on iPhone or iPad',
    steps: [
      <>
        Tap Share <IonIcon icon={shareOutline} aria-hidden="true" />: in the address bar in Chrome and Edge, in the menu in other browsers. In an app’s built-in browser,
        open this page in Safari first.
      </>,
      'Tap “Add to Home Screen”.',
      'Tap Add, then open Subify from your Home Screen.',
    ],
  },
  android: {
    label: 'Android',
    steps: [
      <>
        Open the browser’s menu <IonIcon icon={ellipsisVertical} aria-hidden="true" />.
      </>,
      'Tap “Install app” or “Add to Home screen”.',
      'Confirm, then open Subify from your home screen.',
    ],
  },
  'mac-safari': {
    label: 'Safari on Mac',
    steps: ['In the menu bar, choose File › Add to Dock.', 'Click Add, then open Subify from the Dock.'],
  },
};

/**
 * Starts installing the app: the browser's own dialog where it has one, otherwise a guide to the
 * steps in this browser. `onBackup` opens the backup, for iOS, where the installed app starts empty.
 */
export function useInstallFlow(onBackup: () => void): { start(): void; guide: ReactNode } {
  const { install, promptInstall } = useAppData();
  const [shown, setShown] = useState<InstallGuide | null>(null);

  const start = () => {
    if (install === 'prompt') {
      void promptInstall();
    } else if (canInstall(install)) {
      setShown(install);
    }
  };

  return { start, guide: <InstallGuideModal guide={shown} onClose={() => setShown(null)} onBackup={onBackup} /> };
}

function InstallGuideModal({ guide, onClose, onBackup }: { guide: InstallGuide | null; onClose(): void; onBackup(): void }) {
  const { db } = useAppData();
  const hasChannels = (useLiveQuery(() => db.subscriptions.count(), [db]) ?? 0) > 0;
  // The browser may not be the one detected: the guide for another stays one tap away.
  const [browser, setBrowser] = useState<InstallGuide>('ios-safari');
  // The backup opens once the guide has gone, rather than over it.
  const afterClose = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (guide !== null) {
      setBrowser(guide);
    }
  }, [guide]);

  return (
    <IonModal
      isOpen={guide !== null}
      onDidDismiss={() => {
        onClose();
        afterClose.current?.();
        afterClose.current = null;
      }}
      initialBreakpoint={0.75}
      breakpoints={[0, 0.75, 1]}
    >
      <IonHeader>
        <IonToolbar>
          <IonTitle>Install the app</IonTitle>
          <IonButtons slot="end">
            <IonButton strong onClick={onClose}>
              Done
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <IonList inset>
          <IonItem lines="none">
            <IonSelect label="Browser" interface="popover" value={browser} onIonChange={(event) => setBrowser(event.detail.value as InstallGuide)}>
              {(Object.keys(GUIDES) as InstallGuide[]).map((key) => (
                <IonSelectOption key={key} value={key}>
                  {GUIDES[key].label}
                </IonSelectOption>
              ))}
            </IonSelect>
          </IonItem>
        </IonList>
        <IonList inset>
          {GUIDES[browser].steps.map((step, index) => (
            <IonItem key={index} {...(index === GUIDES[browser].steps.length - 1 ? { lines: 'none' as const } : {})}>
              <IonNote slot="start">{index + 1}</IonNote>
              <IonLabel className="ion-text-wrap install-step">{step}</IonLabel>
            </IonItem>
          ))}
        </IonList>
        {startsEmptyOnceInstalled(browser) &&
          (hasChannels ? (
            <>
              <IonNote color="medium" className="ion-display-block ion-padding-horizontal">
                Your channels stay in this browser: the app on your Home Screen starts empty. To bring them along, save a backup here, then restore it in the app.
              </IonNote>
              <IonButton
                fill="clear"
                onClick={() => {
                  afterClose.current = onBackup;
                  onClose();
                }}
              >
                Save a backup
              </IonButton>
            </>
          ) : (
            <IonNote color="medium" className="ion-display-block ion-padding-horizontal">
              Add your channels once the app is installed: it doesn’t share them with this browser.
            </IonNote>
          ))}
      </IonContent>
    </IonModal>
  );
}
