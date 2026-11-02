import { IonButton, IonButtons, IonCheckbox, IonContent, IonHeader, IonItem, IonList, IonModal, IonNote, IonTitle, IonToolbar } from '@ionic/react';
import { useAppData } from '../app/AppData';
import { ALL_TYPES, type ShownType, type Subscription } from '../data/db';

const LABELS: Record<ShownType, string> = { video: 'Videos', short: 'Shorts', live: 'Lives' };

/** Which kinds of upload this channel shows in the feed. At least one stays on. */
export function ChannelTypesModal({ channel, onClose }: { channel: Subscription | null; onClose(): void }) {
  const { db } = useAppData();

  const toggle = async (type: ShownType, on: boolean) => {
    if (channel === null) {
      return;
    }

    const types = on ? [...new Set([...channel.types, type])] : channel.types.filter((candidate) => candidate !== type);

    if (types.length > 0) {
      await db.subscriptions.update(channel.key, { types: ALL_TYPES.filter((candidate) => types.includes(candidate)) });
    }
  };

  return (
    <IonModal isOpen={channel !== null} onDidDismiss={onClose} initialBreakpoint={0.5} breakpoints={[0, 0.5]}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>{channel?.title}</IonTitle>
          <IonButtons slot="end">
            <IonButton strong onClick={onClose}>
              Done
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <IonList inset>
          {ALL_TYPES.map((type) => {
            const checked = channel?.types.includes(type) ?? false;

            return (
              <IonItem key={type}>
                <IonCheckbox
                  checked={checked}
                  disabled={checked && channel?.types.length === 1}
                  onIonChange={(event) => void toggle(type, event.detail.checked)}
                >
                  {LABELS[type]}
                </IonCheckbox>
              </IonItem>
            );
          })}
        </IonList>
        <IonNote color="medium" className="ion-display-block ion-padding-horizontal">Uploads not yet sorted into a kind show with videos.</IonNote>
      </IonContent>
    </IonModal>
  );
}
