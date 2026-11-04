import { IonButton, IonContent, IonIcon, IonPopover } from '@ionic/react';
import { informationCircleOutline } from 'ionicons/icons';
import { type ReactNode, useState } from 'react';

/**
 * An ⓘ beside a short line, opening a tooltip that explains it. Taps on either stay theirs: the
 * row it sits in doesn't open.
 */
export function InfoButton({ label, children }: { label: string; children: ReactNode }) {
  const [from, setFrom] = useState<Event | null>(null);

  return (
    <>
      <IonButton
        fill="clear"
        size="small"
        color="medium"
        className="info-button"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          setFrom(event.nativeEvent);
        }}
      >
        <IonIcon slot="icon-only" icon={informationCircleOutline} />
      </IonButton>
      <IonPopover className="info-popover" isOpen={from !== null} event={from ?? undefined} onDidDismiss={() => setFrom(null)} onClick={(event) => event.stopPropagation()}>
        <IonContent className="ion-padding">{children}</IonContent>
      </IonPopover>
    </>
  );
}

/** Why a channel shows no videos: the server keeps none older than six months (RETENTION_DAYS), even when it's added. */
export function NotFetchedInfo({ title }: { title: string }) {
  return (
    <InfoButton label={`Why no videos from ${title}`}>
      <p className="ion-no-margin">Only videos from the last six months are fetched. New uploads will show up here.</p>
      <p className="ion-no-margin ion-padding-top">Recent ones may also be of kinds you hide, or not read yet.</p>
    </InfoButton>
  );
}
