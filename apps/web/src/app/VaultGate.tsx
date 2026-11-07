import { IonButton, IonContent, IonInput, IonItem, IonList, IonNote, IonPage, IonSpinner, useIonAlert } from '@ionic/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { lockClosedOutline } from 'ionicons/icons';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { Column } from '../components/Page';
import { createVault, readKeyring, unlockWithBiometrics, unlockWithPassword } from '../data/vault';
import { askPasskey } from '../ui/biometrics';
import { resetEverything } from '../ui/reset';
import { useAppData } from './AppData';
import { Tour, Welcome } from './Welcome';

/**
 * Nothing that reads the database shows until it is open. A first launch seals the database with
 * a key the device keeps, without asking anything; an app the user locked asks for Face ID / a
 * fingerprint or the password, whichever it has.
 */
export function VaultGate({ children }: { children: ReactNode }) {
  const { vault } = useAppData();

  switch (vault) {
    case 'starting':
      return null;
    case 'setup':
      return <FirstVisit />;
    case 'locked':
      return <Unlock />;
    case 'open':
      return <>{children}</>;
  }
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <IonPage>
      <IonContent className="headerless">
        <div slot="fixed" className="status-backdrop" />
        <Column>{children}</Column>
      </IonContent>
    </IonPage>
  );
}

/**
 * A first visit sees the welcome and the tour, then the app, its data already sealed. An app
 * already in use, whose data predates the sealing, is sealed at once.
 */
function FirstVisit() {
  const { db, vaultOpened } = useAppData();
  const [stage, setStage] = useState<'checking' | 'welcome' | 'sealing' | 'failed'>('checking');

  const seal = async (restore: boolean) => {
    setStage('sealing');

    try {
      await createVault(db);
    } catch {
      setStage('failed');

      return;
    }

    // The router starts once the app opens: it starts on Settings, which offers the backup.
    if (restore) {
      history.replaceState(null, '', '/settings?restore=1');
    }

    vaultOpened();
  };

  useEffect(() => {
    void db.subscriptions.count().then((count) => (count > 0 ? void seal(false) : setStage('welcome')));
    // Once, at the first launch.
  }, [db]);

  if (stage === 'welcome') {
    return <Welcome onDone={(restore) => void seal(restore)} />;
  }

  if (stage === 'failed') {
    return (
      <Screen>
        <EmptyState icon={lockClosedOutline} heading="Subify couldn’t start">
          It couldn’t prepare its storage on this device.
        </EmptyState>
        <div className="ion-padding">
          <IonButton expand="block" onClick={() => void seal(false)}>
            Try again
          </IonButton>
        </div>
      </Screen>
    );
  }

  return null;
}

function Unlock() {
  const { db, vaultOpened } = useAppData();
  const [presentAlert] = useIonAlert();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Read before any tap: Safari asks for Face ID only while the tap is being handled.
  const keyring = useLiveQuery(() => readKeyring(db), [db]);
  const [touring, setTouring] = useState(false);

  if (keyring === undefined) {
    return null;
  }

  const biometrics = keyring.biometrics?.sealed == null ? null : keyring.biometrics;
  const hasPassword = keyring.password !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (busy) {
      return;
    }

    setBusy(true);
    setError(null);

    if (await unlockWithPassword(db, password)) {
      vaultOpened();
    } else {
      setError('That’s not the password.');
      setBusy(false);
    }
  };

  const useBiometrics = async () => {
    if (biometrics === null) {
      return;
    }

    setError(null);
    const output = (await askPasskey(biometrics.credential, biometrics.salt))?.output ?? null;

    if (output !== null && (await unlockWithBiometrics(db, output))) {
      vaultOpened();
    } else {
      setError('The passkey didn’t unlock the app.');
    }
  };

  const forgot = () => {
    void presentAlert({
      header: hasPassword ? 'Forgot the password?' : 'Passkey doesn’t work?',
      message: `${hasPassword ? 'The password can’t be recovered' : 'Without the passkey, nothing can open the app’s data'}, not even whoever runs the server. You can only reset the app, which deletes everything on this device, then restore a backup.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Reset the app',
          role: 'destructive',
          handler: () => void resetEverything(db),
        },
      ],
    });
  };

  if (touring) {
    return <Tour onDone={() => setTouring(false)} finish="Done" />;
  }

  return (
    <Screen>
      <EmptyState icon={lockClosedOutline} heading="Subify is locked">
        {hasPassword && biometrics !== null
          ? 'Use your passkey or your password to open the app.'
          : hasPassword
            ? 'Enter your password to open the app.'
            : 'Use your passkey to open the app.'}
      </EmptyState>
      <form onSubmit={(event) => void submit(event)}>
        {hasPassword && (
          <IonList inset>
            <IonItem lines="none">
              <IonInput
                label="Password"
                labelPlacement="stacked"
                type="password"
                autocomplete="current-password"
                value={password}
                onIonInput={(event) => setPassword(String(event.detail.value ?? ''))}
              />
            </IonItem>
          </IonList>
        )}
        <Note error={error} />
        <div className="ion-padding">
          {biometrics !== null && (
            <IonButton expand="block" fill={hasPassword ? 'outline' : 'solid'} onClick={() => void useBiometrics()}>
              Use your passkey
            </IonButton>
          )}
          {hasPassword && (
            <IonButton expand="block" type="submit" disabled={busy}>
              {busy ? <IonSpinner name="dots" aria-label="Unlocking…" /> : 'Unlock'}
            </IonButton>
          )}
          <IonButton expand="block" fill="clear" color="medium" onClick={forgot}>
            {hasPassword ? 'Forgot the password?' : 'Passkey doesn’t work?'}
          </IonButton>
          <IonButton expand="block" fill="clear" color="medium" onClick={() => setTouring(true)}>
            Take the tour
          </IonButton>
        </div>
      </form>
    </Screen>
  );
}

function Note({ error, children }: { error: string | null; children?: ReactNode }) {
  if (error !== null) {
    return (
      <IonNote color="danger" role="alert" className="ion-display-block ion-padding-horizontal">
        {error}
      </IonNote>
    );
  }

  return children === undefined ? null : (
    <IonNote color="medium" className="ion-display-block ion-padding-horizontal">
      {children}
    </IonNote>
  );
}
