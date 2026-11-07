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
  lockOpenOutline,
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
import { useBiometricsFlow } from '../app/BiometricsFlow';
import { useSecretFlow } from '../app/SecretFlow';
import { useInstallFlow } from '../components/InstallGuide';
import { Page } from '../components/Page';
import { ContactModal } from '../components/ContactModal';
import { Section } from '../components/Section';
import { ServerError } from '../data/api';
import { type Backup, exportBackup, isBackupFile, readBackup, restoreBackup } from '../data/backup';
import { BackupError, MINIMUM_PASSWORD_LENGTH } from '../data/backup-cipher';
import { connectionCheckOn, setConnectionCheck } from '../data/connection-check';
import { getMeta, setMeta } from '../data/db';
import { forgetSecretChannels } from '../data/secret';
import { ageLabel } from '../data/format';
import { loadTheme, type Theme } from '../data/settings';
import { canUnlock, changePassword, isAppPassword, LOCK_AFTER_CHOICES, type LockAfter, readKeyring, removeBiometrics, setLockAfter, setPassword as setAppPassword } from '../data/vault';
import { SHARE_ICON } from '../ui/icons';
import { canInstall, isIos } from '../ui/install';
import { resetEverything } from '../ui/reset';
import { useToast } from '../ui/toast';

type PasswordStep = { kind: 'export'; thenInstall?: boolean } | { kind: 'restore'; file: string } | { kind: 'change' } | { kind: 'set' };

export function SettingsPage() {
  const { db, api, gate, install, lock, sync } = useAppData();
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
  // A backup opens with the app's password, when it has one, unless the user picks another one.
  const [appPassword, setUseAppPassword] = useState(true);
  const biometrics = useBiometricsFlow();
  // Redraws a choice the user cancelled or the device refused, so it shows the one still in force.
  const [lockChoiceDrawn, setLockChoiceDrawn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The install guide reopens once the backup it asked for is saved and the password dialog has gone.
  const reopenGuide = useRef(false);

  const theme = useLiveQuery(() => loadTheme(db), [db]) ?? 'system';
  const lastExportAt = useLiveQuery(() => getMeta<number>(db, 'lastExportAt'), [db]);
  const checksConnection = useLiveQuery(() => connectionCheckOn(db), [db]) ?? false;
  const keyring = useLiveQuery(() => readKeyring(db), [db]);
  const hasPassword = (keyring?.password ?? null) !== null;
  const biometricsOn = (keyring?.biometrics ?? null) !== null;
  const locks = canUnlock(keyring);
  // Locked for real only when the key isn't kept on the device (“never”).
  const protectedByLock = locks && keyring?.lockAfter !== 'never';
  const passkeyLocks = (keyring?.biometrics?.sealed ?? null) !== null;
  const lockedWith = passkeyLocks && hasPassword ? 'passkey or password' : passkeyLocks ? 'passkey' : 'password';
  // What locking adds to the encryption every device has, said plainly: it is the question people ask.
  const lockExplained = protectedByLock
    ? `Someone using your unlocked ${platformDevice()}, or holding a copy of its data, can’t read your channels. If you lose your ${lockedWith}, nothing can open them again: only a backup brings them back.`
    : [
        `Subify’s data is encrypted, and safe on a lost or stolen ${platformDevice()} that is locked. But its key stays on this device: anyone using your unlocked ${platformDevice()} can open Subify, and a copy of the device’s data can be read.`,
        locks
          ? 'To close both, choose when Subify asks to unlock.'
          : biometricsOn
            ? 'Your passkey’s password manager can’t lock Subify: the passkey only shows secret channels. To close both, set a password.'
            : 'To close both, lock Subify with a passkey or a password.',
      ].join(' ');
  // Whether the passkey is the secret channels' lock, with secret channels to guard.
  const passkeyGuardsSecrets = useLiveQuery(async () => (await getMeta(db, 'secretUnlock')) === 'app' && (await db.subscriptions.filter((channel) => channel.secret).count()) > 0, [db]) ?? false;

  const hasSecrets = useLiveQuery(async () => (await db.subscriptions.filter((channel) => channel.secret).count()) > 0, [db]);
  const secretFlow = useSecretFlow();

  const toast = (message: string) => showToast(message, 2500);

  const openPassword = (step: PasswordStep) => {
    // A backup opens with a password its maker picks, and shows everything in it: saving one asks
    // first for what shows the secret channels, or the backup would show them to anyone holding the app.
    // The alert says why, and gives the tap the passkey needs to be asked for (Safari).
    if (step.kind === 'export' && hasSecrets !== false) {
      void presentAlert({
        header: 'Unlock your secret channels',
        message: `The backup holds your secret channels too, and anyone with the file and its password can see them. Unlock them first, as you do to show them, so that no one else using your unlocked ${platformDevice()} can take them away in a backup.`,
        buttons: [
          { text: 'Cancel', role: 'cancel' },
          { text: 'Unlock', handler: () => void secretFlow.confirmSecrets().then((confirmed) => confirmed && askPassword(step)) },
        ],
      });

      return;
    }

    askPassword(step);
  };

  const askPassword = (step: PasswordStep) => {
    setPassword('');
    setRepeat('');
    setCurrent('');
    setUseAppPassword(hasPassword);
    setError(null);
    setPasswordStep(step);
  };

  const installFlow = useInstallFlow(() => openPassword({ kind: 'export', thenInstall: true }));

  // The install guide on the feed links here to save a backup before installing on iOS or a Mac, then
  // reopens; the storage warning links here to save one.
  useEffect(() => {
    // Waits to know whether there are secret channels to unlock first.
    if (searchParams.get('backup') !== null && hasSecrets !== undefined) {
      setSearchParams({}, { replace: true });
      openPassword({ kind: 'export', thenInstall: searchParams.get('backup') === 'install' });
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
  }, [searchParams, setSearchParams, presentAlert, hasSecrets]);

  // How the backup's secret channels come back: a passkey or an app's password stays on its device, a PIN travels.
  const restoredSecrets = (backup: Backup) =>
    !backup.channels.some((channel) => channel.secret)
      ? ''
      : backup.secretCodeHash !== null
        ? ' Its secret channels stay hidden, behind the same PIN as on the device that saved it.'
        : ' Its secret channels stay hidden. Their passkey or password stayed on the device that saved them: here, they unlock with this device’s passkey, or a lock you choose the first time you show them.';

  const confirmRestore = (backup: Backup) => {
    void presentAlert({
      header: 'Restore this backup?',
      message: `Your channels and settings on this device will be replaced by the ${backup.channels.length} channels of the backup.${restoredSecrets(backup)}`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Restore',
          handler: () => {
            void gate
              .run(api, async () => {
                const result = await restoreBackup(db, api, backup);
                void toast(result.queued > 0 ? `Backup restored. ${result.queued} channels will be added one at a time.` : 'Backup restored.');
                // The channels show already, blurred: their thumbnails come in the refresh that follows, with its bar.
                void sync(true);
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
      if (passwordStep.kind === 'change' || passwordStep.kind === 'set') {
        if (password !== repeat) {
          throw new BackupError('The two passwords are different.');
        }

        if (password.length < MINIMUM_PASSWORD_LENGTH) {
          throw new BackupError(`The password needs at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
        }

        if (passwordStep.kind === 'set') {
          await setAppPassword(db, password);
        } else if (!(await changePassword(db, current, password))) {
          throw new BackupError('That’s not the current password.');
        }

        setPasswordStep(null);
        void toast(passwordStep.kind === 'set' ? 'Password set.' : 'Password changed.');
      } else if (passwordStep.kind === 'export') {
        if (appPassword ? !(await isAppPassword(db, password)) : password !== repeat) {
          throw new BackupError(appPassword ? 'That’s not the app’s password.' : 'The two passwords are different.');
        }

        const saved = await saveFile(await exportBackup(db, password), `subify-backup-${new Date().toISOString().slice(0, 10)}.json`);
        reopenGuide.current = saved && passwordStep.thenInstall === true;
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
      header: 'Never ask to unlock?',
      message: 'The app then keeps its key on this device, so your channels and settings can be read there by anyone who gets at the app’s data. You can change this at any time.',
      buttons: [
        { text: 'Cancel', role: 'cancel', handler: () => setLockChoiceDrawn((drawn) => drawn + 1) },
        { text: 'Never ask', role: 'destructive', handler: () => void setLockAfter(db, 'never') },
      ],
    });
  };

  const toggleBiometrics = async (on: boolean) => {
    if (on) {
      if (!(await biometrics.turnOn())) {
        setLockChoiceDrawn((drawn) => drawn + 1);
      }

      return;
    }

    // Without a password, the passkey alone keeps secret channels out of sight: turned off, it
    // would leave them with no lock, and anyone holding the open app could choose a PIN for them.
    if (passkeyGuardsSecrets && !hasPassword) {
      setLockChoiceDrawn((drawn) => drawn + 1);
      void presentAlert({
        header: 'Your secret channels need another lock',
        message:
          'The passkey is all that keeps them out of sight. Choose a PIN for them first (Channels, ⋯, Change secret code) or set a password, then turn the passkey off. If you no longer have the passkey, turning it off removes your secret channels, with their videos. Your other channels stay.',
        buttons: [
          { text: 'OK', role: 'cancel' },
          {
            text: 'Remove secret channels',
            role: 'destructive',
            handler: () =>
              void forgetSecretChannels(db)
                .then(() => turnOff())
                .catch(() => toast('Something went wrong. Try again.')),
          },
        ],
      });

      return;
    }

    await turnOff();
  };

  const turnOff = async () => {
    const opensWithoutAsking = !hasPassword && keyring?.lockAfter !== 'never';
    await removeBiometrics(db);
    await db.meta.delete('secretCredential');
    // The passkey stays in the password manager, to be used again: nothing to delete there.
    await toast(`Passkey off.${opensWithoutAsking ? ' Subify now opens without asking.' : ''} Turning it on again saves nothing new.`);
  };

  const confirmReset = () => {
    void presentAlert({
      header: 'Reset the app?',
      message: `Your channels, videos, settings and secret code will be deleted from this device. This can’t be undone.${
        keyring?.passkey !== undefined || biometricsOn ? ' Subify’s passkey stays in your password manager, under subify.tv: you can delete it there.' : ''
      }`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Reset', role: 'destructive', handler: () => void resetEverything(db) },
      ],
    });
  };

  const passwordModal = (
    <IonModal
      isOpen={passwordStep !== null}
      onDidDismiss={() => {
        setPasswordStep(null);

        if (reopenGuide.current) {
          reopenGuide.current = false;
          installFlow.start();
        }
      }}
    >
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonButton onClick={() => setPasswordStep(null)}>Cancel</IonButton>
          </IonButtons>
          <IonTitle>
            {passwordStep?.kind === 'export' ? 'Backup password' : passwordStep?.kind === 'change' ? 'Change the password' : passwordStep?.kind === 'set' ? 'Set a password' : 'Open the backup'}
          </IonTitle>
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
            {passwordStep?.kind === 'export' && hasPassword && (
              <IonItem>
                <IonToggle checked={appPassword} onIonChange={(event) => setUseAppPassword(event.detail.checked)}>
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
            {(passwordStep?.kind === 'change' || passwordStep?.kind === 'set' || (passwordStep?.kind === 'export' && !appPassword)) && (
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
              {passwordStep?.kind === 'change' || passwordStep?.kind === 'set'
                ? `At least ${MINIMUM_PASSWORD_LENGTH} characters. Once the app asks for it, losing it means the app’s data can’t be opened again: only a backup lets you start over.`
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
        footer={lockExplained}
      >
        <IonItem>
          <IonIcon slot="start" icon={protectedByLock ? lockClosedOutline : lockOpenOutline} aria-hidden="true" />
          <IonLabel className="ion-text-wrap">
            <h2>{protectedByLock ? `Locked with your ${lockedWith}` : 'Encrypted, opens without asking'}</h2>
            <p>{protectedByLock ? `Only your ${lockedWith} opens Subify’s data` : `Its key stays on this device, behind your ${platformLock()}`}</p>
          </IonLabel>
        </IonItem>
        {(biometrics.available || biometricsOn) && (
          <IonItem>
            <IonIcon slot="start" icon={fingerPrintOutline} aria-hidden="true" />
            <IonToggle key={lockChoiceDrawn} checked={biometricsOn} onIonChange={(event) => void toggleBiometrics(event.detail.checked)}>
              <IonLabel>
                <h2>Passkey</h2>
                <p>With {biometrics.verifiedBy}</p>
              </IonLabel>
            </IonToggle>
          </IonItem>
        )}
        <IonItem button detail={false} {...(locks ? {} : { lines: 'none' as const })} onClick={() => openPassword({ kind: hasPassword ? 'change' : 'set' })}>
          <IonIcon slot="start" icon={keyOutline} aria-hidden="true" />
          <IonLabel>{hasPassword ? 'Change the password' : 'Set a password'}</IonLabel>
        </IonItem>
        {locks && (
          <>
            <IonItem>
              <IonIcon slot="start" icon={timerOutline} aria-hidden="true" />
              <IonSelect
                key={lockChoiceDrawn}
                label="Ask to unlock"
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
            <IonItem button detail={false} lines="none" onClick={() => void lock()}>
              <IonIcon slot="start" icon={lockClosedOutline} aria-hidden="true" />
              <IonLabel>Lock now</IonLabel>
            </IonItem>
          </>
        )}
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

/**
 * The share sheet on a phone or tablet (iOS, Android), where it saves to Files or Drive; a download
 * elsewhere. A computer's share sheet (Safari on a Mac) sends the file to a person or an app rather
 * than keeping it, while restoring needs it on the disk. False when the user cancelled the sheet.
 */
async function saveFile(contents: string, name: string): Promise<boolean> {
  const file = new File([contents], name, { type: 'application/json' });
  const mobile = isIos(navigator.userAgent, navigator.maxTouchPoints) || /Android/.test(navigator.userAgent);

  if (mobile && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });

      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return false;
      }
    }
  }

  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);

  return true;
}

/** What already guards the app's data when Subify doesn't lock itself. */
function platformLock(): string {
  return `${platformDevice()}’s lock`;
}

function platformDevice(): 'phone' | 'computer' {
  return /iPhone|iPad|Android/.test(navigator.userAgent) || navigator.maxTouchPoints > 1 ? 'phone' : 'computer';
}
