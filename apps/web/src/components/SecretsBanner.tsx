import { IonButton, IonIcon, IonItem, IonLabel } from '@ionic/react';
import { eyeOffOutline } from 'ionicons/icons';
import { useAppData } from '../app/AppData';
import { useSecretFlow } from '../app/SecretFlow';

/**
 * While the secret channels are shown, or one of them opened on its own (`opened`), a banner says
 * so at the top of the page, with a way to hide them at once: showing them is a passing state,
 * like a browser's private window.
 */
export function SecretsBanner({ opened = false }: { opened?: boolean }) {
  const { secretsShown, setSecretOpened } = useAppData();
  const { toggleSecrets } = useSecretFlow();

  if (!secretsShown && !opened) {
    return null;
  }

  return (
    <IonItem color="primary" lines="none" className="secrets-banner" role="status">
      <IonIcon slot="start" icon={eyeOffOutline} aria-hidden="true" />
      <IonLabel>{secretsShown ? 'Secret channels shown' : 'Secret channel shown'}</IonLabel>
      <IonButton slot="end" fill="clear" onClick={secretsShown ? toggleSecrets : () => setSecretOpened(null)}>
        Hide
      </IonButton>
    </IonItem>
  );
}
