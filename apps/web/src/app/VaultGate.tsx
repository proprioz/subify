import { IonButton, IonContent, IonInput, IonItem, IonList, IonNote, IonPage, IonSpinner, useIonAlert } from '@ionic/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { lockClosedOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { Column } from '../components/Page';
import { addBiometrics, createVault, MINIMUM_PASSWORD_LENGTH, readKeyring, unlockWithBiometrics, unlockWithPassword } from '../data/vault';
import { biometricsKey, biometricsKeyAvailable, enrollBiometricsKey } from '../ui/biometrics';
import { resetEverything } from '../ui/reset';
import { useAppData } from './AppData';
import { Tour, Welcome } from './Welcome';

export const BIOMETRICS = 'Face ID or fingerprint';

/**
 * Nothing that reads the database shows until it is open: the first launch asks for a password,
 * every other launch (and a lock the user chose) for that password, or Face ID / a fingerprint.
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
      <IonContent>
        <Column>{children}</Column>
      </IonContent>
    </IonPage>
  );
}

/**
 * A first visit sees the welcome and the tour, then chooses the password. An app already in use,
 * whose data predates the password, goes straight to the password.
 */
function FirstVisit() {
  const { db } = useAppData();
  const [stage, setStage] = useState<'checking' | 'welcome' | { restore: boolean }>('checking');

  useEffect(() => {
    void db.subscriptions.count().then((count) => setStage(count > 0 ? { restore: false } : 'welcome'));
  }, [db]);

  if (stage === 'checking') {
    return null;
  }

  return stage === 'welcome' ? <Welcome onDone={(restore) => setStage({ restore })} /> : <ChoosePassword restore={stage.restore} />;
}

/** `restore`: the user came to restore a backup, which Settings offers once the password is chosen. */
function ChoosePassword({ restore }: { restore: boolean }) {
  const { db, vaultOpened } = useAppData();
  const [presentAlert] = useIonAlert();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const offerBiometrics = () => {
    void presentAlert({
      header: `Unlock with ${BIOMETRICS}?`,
      message: 'Open Subify without typing your password. Your device keeps a passkey for this in the password manager you pick; it never leaves the device. The password keeps working.',
      buttons: [
        { text: 'Not now', role: 'cancel' },
        { text: `Use ${BIOMETRICS}`, handler: () => void turnOnBiometrics(db) },
      ],
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (busy) {
      return;
    }

    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setError(`The password needs at least ${MINIMUM_PASSWORD_LENGTH} characters.`);

      return;
    }

    if (password !== repeat) {
      setError('The two passwords are different.');

      return;
    }

    // Said once, at the moment it matters, rather than on the screen where it would worry first.
    void presentAlert({
      header: 'Keep it somewhere safe',
      message: 'No one can reset this password, not even whoever runs the server. If you lose it, the app’s data can’t be opened again: only a backup lets you start over.',
      buttons: [
        { text: 'Back', role: 'cancel' },
        { text: 'I’ll keep it safe', handler: () => void create() },
      ],
    });
  };

  const create = async () => {
    setBusy(true);
    setError(null);

    try {
      await createVault(db, password);

      // The router starts once the app opens: it starts on Settings, which offers the backup.
      if (restore) {
        history.replaceState(null, '', '/settings?restore=1');
      }

      vaultOpened();

      if (await biometricsKeyAvailable()) {
        offerBiometrics();
      }
    } catch {
      setError('Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <Screen>
      <EmptyState icon={shieldCheckmarkOutline} heading="Lock your Subify">
        Your channels stay yours. This password locks everything Subify keeps on this device, so no one else can read it.
      </EmptyState>
      <form onSubmit={(event) => void submit(event)}>
        <IonList inset>
          <IonItem>
            <IonInput
              label="Password"
              labelPlacement="stacked"
              type="password"
              autocomplete="new-password"
              value={password}
              onIonInput={(event) => setPassword(String(event.detail.value ?? ''))}
            />
          </IonItem>
          <IonItem lines="none">
            <IonInput
              label="Repeat the password"
              labelPlacement="stacked"
              type="password"
              autocomplete="new-password"
              value={repeat}
              onIonInput={(event) => setRepeat(String(event.detail.value ?? ''))}
            />
          </IonItem>
        </IonList>
        <Note error={error}>At least {MINIMUM_PASSWORD_LENGTH} characters. You choose in Settings when the app asks for it again.</Note>
        <div className="ion-padding">
          <IonButton expand="block" type="submit" disabled={busy}>
            {busy ? <IonSpinner name="dots" aria-label="Encrypting…" /> : 'Continue'}
          </IonButton>
        </div>
      </form>
    </Screen>
  );
}

function Unlock() {
  const { db, vaultOpened } = useAppData();
  const [presentAlert] = useIonAlert();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Read before any tap: Safari asks for Face ID only while the tap is being handled.
  const biometrics = useLiveQuery(async () => (await readKeyring(db))?.biometrics ?? null, [db]);
  const [touring, setTouring] = useState(false);

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
    if (biometrics === null || biometrics === undefined) {
      return;
    }

    setError(null);
    const output = await biometricsKey(biometrics.credential, biometrics.salt);

    if (output !== null && (await unlockWithBiometrics(db, output))) {
      vaultOpened();
    } else {
      setError(`${BIOMETRICS} didn’t unlock the app.`);
    }
  };

  const forgot = () => {
    void presentAlert({
      header: 'Forgot the password?',
      message: 'It can’t be recovered, and nothing on this device opens without it. You can only reset the app, which deletes everything on this device, then restore a backup.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Reset the app', role: 'destructive', handler: () => void resetEverything(db) },
      ],
    });
  };

  if (touring) {
    return <Tour onDone={() => setTouring(false)} finish="Done" />;
  }

  return (
    <Screen>
      <EmptyState icon={lockClosedOutline} heading="Subify is locked">
        Enter your password to open the app.
      </EmptyState>
      <form onSubmit={(event) => void submit(event)}>
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
        <Note error={error} />
        <div className="ion-padding">
          <IonButton expand="block" type="submit" disabled={busy}>
            {busy ? <IonSpinner name="dots" aria-label="Unlocking…" /> : 'Unlock'}
          </IonButton>
          {biometrics !== null && biometrics !== undefined && (
            <IonButton expand="block" fill="outline" onClick={() => void useBiometrics()}>
              Use {BIOMETRICS}
            </IonButton>
          )}
          <IonButton expand="block" fill="clear" color="medium" onClick={forgot}>
            Forgot the password?
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

/** Makes the passkey that unlocks the app. False when the device made none, or one that gives no key. */
export async function turnOnBiometrics(db: Parameters<typeof addBiometrics>[0]): Promise<boolean> {
  try {
    const enrolled = await enrollBiometricsKey();

    if (enrolled === null) {
      return false;
    }

    await addBiometrics(db, enrolled.credential, enrolled.salt, enrolled.output);

    return true;
  } catch {
    return false;
  }
}
