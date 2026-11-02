import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonIcon,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonText,
  IonSpinner,
  IonTitle,
  IonToggle,
  IonToolbar,
  useIonAlert,
} from '@ionic/react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  downloadOutline,
  fingerPrintOutline,
  keyOutline,
  mapOutline,
  lockClosedOutline,
  globeOutline,
  moonOutline,
  phonePortraitOutline,
  shieldCheckmarkOutline,
  sparklesOutline,
  sunnyOutline,
  timerOutline,
  trashOutline,
} from 'ionicons/icons';
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { BIOMETRICS, turnOnBiometrics } from '../app/VaultGate';
import { useInstallFlow } from '../components/InstallGuide';
import { Page } from '../components/Page';
import { ContactModal } from '../components/ContactModal';
import { Section } from '../components/Section';
import { ServerError } from '../data/api';
import { type Backup, exportBackup, isBackupFile, readBackup, restoreBackup } from '../data/backup';
import { BackupError, MINIMUM_PASSWORD_LENGTH } from '../data/backup-cipher';
import { connectionCheckOn, setConnectionCheck } from '../data/connection-check';
import { getMeta, setMeta } from '../data/db';
import { ageLabel } from '../data/format';
import { loadTheme, type Theme } from '../data/settings';
import { changePassword, isAppPassword, LOCK_AFTER_CHOICES, type LockAfter, readKeyring, removeBiometrics, setLockAfter } from '../data/vault';
import { biometricsKeyAvailable } from '../ui/biometrics';
import { SHARE_ICON } from '../ui/icons';
import { canInstall } from '../ui/install';
import { resetEverything } from '../ui/reset';
import { useToast } from '../ui/toast';

type PasswordStep = { kind: 'export' } | { kind: 'restore'; file: string } | { kind: 'change' };

export function SettingsPage() {
  const { db, api, gate, install, lock } = useAppData();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [presentAlert] = useIonAlert();
  const showToast = useToast();
  const backupInput = useRef<HTMLInputElement>(null);
  const [contacting, setContacting] = useState(false);
  const [passwordStep, setPasswordStep] = useState<PasswordStep | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [current, setCurrent] = useState('');
  // A backup opens with the app's password unless the user picks another one.
  const [appPassword, setAppPassword] = useState(true);
  const [biometricsHere, setBiometricsHere] = useState(false);
  // Redraws the choice when “Never” is cancelled, so it shows the one still in force.
  const [lockChoiceDrawn, setLockChoiceDrawn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const theme = useLiveQuery(() => loadTheme(db), [db]) ?? 'system';
  const lastExportAt = useLiveQuery(() => getMeta<number>(db, 'lastExportAt'), [db]);
  const checksConnection = useLiveQuery(() => connectionCheckOn(db), [db]) ?? false;
  const keyring = useLiveQuery(() => readKeyring(db), [db]);

  useEffect(() => {
    void biometricsKeyAvailable().then(setBiometricsHere);
  }, []);

  const toast = (message: string) => showToast(message, 2500);

  const openPassword = (step: PasswordStep) => {
    setPassword('');
    setRepeat('');
    setCurrent('');
    setAppPassword(true);
    setError(null);
    setPasswordStep(step);
  };

  const installFlow = useInstallFlow(() => openPassword({ kind: 'export' }));

  // The install guide on the feed links here to save a backup before installing on iOS.
  useEffect(() => {
    if (searchParams.get('backup') !== null) {
      setSearchParams({}, { replace: true });
      openPassword({ kind: 'export' });
    }

    // A first visit that came to restore a backup lands here: the file picker needs a tap to open.
    if (searchParams.get('restore') !== null) {
      setSearchParams({}, { replace: true });
      void presentAlert({
        header: 'Restore your backup',
        message: 'Choose the backup file you saved, then enter its password.',
        buttons: [
          { text: 'Not now', role: 'cancel' },
          { text: 'Choose the file', handler: () => backupInput.current?.click() },
        ],
      });
    }
  }, [searchParams, setSearchParams, presentAlert]);

  const confirmRestore = (backup: Backup) => {
    void presentAlert({
      header: 'Restore this backup?',
      message: `Your channels and settings on this device will be replaced by the ${backup.channels.length} channels of the backup.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Restore',
          handler: () => {
            void gate
              .run(api, async () => {
                const result = await restoreBackup(db, api, backup);
                void toast(result.queued > 0 ? `Backup restored. ${result.queued} channels will be added one at a time.` : 'Backup restored.');
              })
              .catch((failure: unknown) => toast(failure instanceof ServerError ? failure.message : 'Couldn’t restore the backup.'));
          },
        },
      ],
    });
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();

    if (passwordStep === null || busy) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      if (passwordStep.kind === 'change') {
        if (password !== repeat) {
          throw new BackupError('The two passwords are different.');
        }

        if (password.length < MINIMUM_PASSWORD_LENGTH) {
          throw new BackupError(`The password needs at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
        }

        if (!(await changePassword(db, current, password))) {
          throw new BackupError('That’s not the current password.');
        }

        setPasswordStep(null);
        void toast('Password changed.');
      } else if (passwordStep.kind === 'export') {
        if (appPassword ? !(await isAppPassword(db, password)) : password !== repeat) {
          throw new BackupError(appPassword ? 'That’s not the app’s password.' : 'The two passwords are different.');
        }

        await saveFile(await exportBackup(db, password), `subify-backup-${new Date().toISOString().slice(0, 10)}.json`);
        setPasswordStep(null);
      } else {
        const backup = await readBackup(passwordStep.file, password);
        setPasswordStep(null);
        confirmRestore(backup);
      }
    } catch (failure) {
      setError(failure instanceof BackupError ? failure.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const pickedBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = await takeFile(event);

    if (file === null) {
      return;
    }

    if (isBackupFile(file)) {
      openPassword({ kind: 'restore', file });
    } else {
      await toast('This file isn’t a Subify backup.');
    }
  };

  const chooseLockAfter = (lockAfter: LockAfter) => {
    if (lockAfter !== 'never') {
      void setLockAfter(db, lockAfter);

      return;
    }

    void presentAlert({
      header: 'Never ask for the password?',
      message: 'The app then keeps its key on this device, so your channels and settings can be read there by anyone who gets at the app’s data. You can change this at any time.',
      buttons: [
        { text: 'Cancel', role: 'cancel', handler: () => setLockChoiceDrawn((drawn) => drawn + 1) },
        { text: 'Never ask', role: 'destructive', handler: () => void setLockAfter(db, 'never') },
      ],
    });
  };

  const toggleBiometrics = async (on: boolean) => {
    if (!on) {
      await removeBiometrics(db);
      await toast(`${BIOMETRICS} turned off. You can delete its passkey from your password manager.`);
    } else if (!(await turnOnBiometrics(db))) {
      await toast(`This device can’t unlock Subify with ${BIOMETRICS}.`);
    }
  };

  const confirmReset = () => {
    void presentAlert({
      header: 'Reset the app?',
      message: 'Your channels, videos, settings and secret code will be deleted from this device. This can’t be undone.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Reset', role: 'destructive', handler: () => void resetEverything(db) },
      ],
    });
  };

  const passwordModal = (
    <IonModal isOpen={passwordStep !== null} onDidDismiss={() => setPasswordStep(null)}>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonButton onClick={() => setPasswordStep(null)}>Cancel</IonButton>
          </IonButtons>
          <IonTitle>{passwordStep?.kind === 'export' ? 'Backup password' : passwordStep?.kind === 'change' ? 'Change the password' : 'Open the backup'}</IonTitle>
          <IonButtons slot="end">
            <IonButton strong type="submit" form="backup-password" disabled={busy}>
              {busy ? <IonSpinner name="dots" /> : passwordStep?.kind === 'restore' ? 'Open' : 'Save'}
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <form id="backup-password" onSubmit={(event) => void submitPassword(event)}>
          <IonList inset>
            {passwordStep?.kind === 'export' && (
              <IonItem>
                <IonToggle checked={appPassword} onIonChange={(event) => setAppPassword(event.detail.checked)}>
                  Use the app’s password
                </IonToggle>
              </IonItem>
            )}
            {passwordStep?.kind === 'change' && (
              <IonItem>
                <IonInput
                  label="Current password"
                  labelPlacement="stacked"
                  type="password"
                  autocomplete="current-password"
                  value={current}
                  onIonInput={(event) => setCurrent(String(event.detail.value ?? ''))}
                />
              </IonItem>
            )}
            <IonItem>
              <IonInput
                label={passwordStep?.kind === 'change' ? 'New password' : passwordStep?.kind === 'export' && appPassword ? 'App password' : 'Password'}
                labelPlacement="stacked"
                type="password"
                autocomplete={passwordStep?.kind === 'restore' || appPassword ? 'current-password' : 'new-password'}
                value={password}
                onIonInput={(event) => setPassword(String(event.detail.value ?? ''))}
              />
            </IonItem>
            {(passwordStep?.kind === 'change' || (passwordStep?.kind === 'export' && !appPassword)) && (
              <IonItem>
                <IonInput
                  label="Repeat the password"
                  labelPlacement="stacked"
                  type="password"
                  autocomplete="new-password"
                  value={repeat}
                  onIonInput={(event) => setRepeat(String(event.detail.value ?? ''))}
                />
              </IonItem>
            )}
          </IonList>
        </form>
        {error !== null ? (
          <IonNote color="danger" className="ion-display-block ion-padding-horizontal" role="alert">
            {error}
          </IonNote>
        ) : (
          passwordStep?.kind !== 'restore' && (
            <IonNote color="medium" className="ion-display-block ion-padding-horizontal">
              {passwordStep?.kind === 'change'
                ? `At least ${MINIMUM_PASSWORD_LENGTH} characters. If you lose it, the app’s data can’t be opened again.`
                : appPassword
                  ? 'The backup opens with the app’s password, on any device. Without it, the backup can’t be opened.'
                  : `At least ${MINIMUM_PASSWORD_LENGTH} characters. It isn’t saved anywhere: without it, the backup can’t be opened.`}
            </IonNote>
          )
        )}
      </IonContent>
    </IonModal>
  );

  return (
    <Page
      title="Settings"
      overlays={
        <>
          <input ref={backupInput} className="file-input" type="file" accept="application/json,.json" onChange={(event) => void pickedBackup(event)} />
          {passwordModal}
          {installFlow.guide}
        </>
      }
    >
      <Section heading="Appearance">
        <IonItem lines="none">
          <IonSegment value={theme} aria-label="Appearance" onIonChange={(event) => void setMeta(db, 'theme', event.detail.value as Theme)}>
            <IonSegmentButton value="light">
              <IonIcon icon={sunnyOutline} aria-hidden="true" />
              <IonLabel>Light</IonLabel>
            </IonSegmentButton>
            <IonSegmentButton value="dark">
              <IonIcon icon={moonOutline} aria-hidden="true" />
              <IonLabel>Dark</IonLabel>
            </IonSegmentButton>
            <IonSegmentButton value="system">
              <IonIcon icon={phonePortraitOutline} aria-hidden="true" />
              <IonLabel>System</IonLabel>
            </IonSegmentButton>
          </IonSegment>
        </IonItem>
      </Section>

      <Section
        heading="Lock"
        footer="Everything Subify keeps on this device is encrypted with your password. If you lose it, the app’s data can’t be opened again: only a backup lets you start over."
      >
        <IonItem>
          <IonIcon slot="start" icon={timerOutline} aria-hidden="true" />
          <IonSelect
            key={lockChoiceDrawn}
            label="Ask for the password"
            labelPlacement="stacked"
            interface="action-sheet"
            value={keyring?.lockAfter ?? 'open'}
            onIonChange={(event) => chooseLockAfter(event.detail.value as LockAfter)}
          >
            {LOCK_AFTER_CHOICES.map(({ value, label }) => (
              <IonSelectOption key={String(value)} value={value}>
                {label}
              </IonSelectOption>
            ))}
          </IonSelect>
        </IonItem>
        {(biometricsHere || (keyring?.biometrics ?? null) !== null) && (
          <IonItem>
            <IonIcon slot="start" icon={fingerPrintOutline} aria-hidden="true" />
            <IonToggle checked={(keyring?.biometrics ?? null) !== null} onIonChange={(event) => void toggleBiometrics(event.detail.checked)}>
              {BIOMETRICS}
            </IonToggle>
          </IonItem>
        )}
        <IonItem button detail={false} onClick={() => openPassword({ kind: 'change' })}>
          <IonIcon slot="start" icon={keyOutline} aria-hidden="true" />
          <IonLabel>Change the password</IonLabel>
        </IonItem>
        <IonItem button detail={false} lines="none" onClick={() => void lock()}>
          <IonIcon slot="start" icon={lockClosedOutline} aria-hidden="true" />
          <IonLabel>Lock now</IonLabel>
        </IonItem>
      </Section>

      <Section
        heading="Backup"
        footer="Your channels live only on this device. A backup holds them and your settings, locked with a password; videos come back from the server. Keep it outside the app, in Files or Google Drive."
      >
        <IonItem button detail={false} onClick={() => openPassword({ kind: 'export' })}>
          <IonIcon slot="start" {...SHARE_ICON} aria-hidden="true" />
          <IonLabel>
            <h2>Save a backup</h2>
            <p>{lastExportAt === undefined ? 'Never saved' : `Last saved ${ageLabel(lastExportAt)}`}</p>
          </IonLabel>
        </IonItem>
        <IonItem button detail={false} lines="none" onClick={() => backupInput.current?.click()}>
          <IonIcon slot="start" icon={downloadOutline} aria-hidden="true" />
          <IonLabel>Restore a backup</IonLabel>
        </IonItem>
      </Section>

      <Section
        heading="Connection"
        footer="Before going online, the app shows which country the server places your connection in, and waits for you to continue. Handy if you use a VPN. While nothing is remembered, channels waiting to be added wait too."
      >
        <IonItem lines="none">
          <IonIcon slot="start" icon={globeOutline} aria-hidden="true" />
          <IonToggle checked={checksConnection} onIonChange={(event) => void setConnectionCheck(db, event.detail.checked)}>
            Check the connection first
          </IonToggle>
        </IonItem>
      </Section>

      <Section heading="About" footer="The server keeps videos for six months: older ones can’t be shown, even for a channel you just added.">
        <IonItem button onClick={() => navigate('/settings/why')}>
          <IonIcon slot="start" icon={sparklesOutline} aria-hidden="true" />
          <IonLabel>Why Subify</IonLabel>
        </IonItem>
        <IonItem button onClick={() => navigate('/settings/tour')}>
          <IonIcon slot="start" icon={mapOutline} aria-hidden="true" />
          <IonLabel>Take the tour</IonLabel>
        </IonItem>
        <IonItem button {...(canInstall(install) ? {} : { lines: 'none' as const })} onClick={() => navigate('/settings/privacy')}>
          <IonIcon slot="start" icon={shieldCheckmarkOutline} aria-hidden="true" />
          <IonLabel>Privacy</IonLabel>
        </IonItem>
        {canInstall(install) && (
          <IonItem button detail={false} lines="none" onClick={installFlow.start}>
            <IonIcon slot="start" icon={downloadOutline} aria-hidden="true" />
            <IonLabel>Install the app</IonLabel>
          </IonItem>
        )}
      </Section>

      <Section footer="Deletes your channels, videos, settings and secret code from this device.">
        <IonItem button detail={false} lines="none" onClick={confirmReset}>
          <IonIcon slot="start" icon={trashOutline} color="danger" aria-hidden="true" />
          <IonText color="danger">Reset app</IonText>
        </IonItem>
      </Section>

      <p className="ion-text-center">
        <button type="button" className="quiet-link" onClick={() => setContacting(true)}>
          Contact
        </button>
      </p>
      <ContactModal isOpen={contacting} onClose={() => setContacting(false)} unlocked />
    </Page>
  );
}

async function takeFile(event: ChangeEvent<HTMLInputElement>): Promise<string | null> {
  const file = event.target.files?.[0];
  event.target.value = '';

  return file === undefined ? null : file.text();
}

/** The share sheet where it can carry a file (iOS, Android), a download elsewhere. */
async function saveFile(contents: string, name: string): Promise<void> {
  const file = new File([contents], name, { type: 'application/json' });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });

      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
    }
  }

  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}
