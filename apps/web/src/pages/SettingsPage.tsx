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
  useIonActionSheet,
  useIonAlert,
} from '@ionic/react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  downloadOutline,
  eyeOffOutline,
  fingerPrintOutline,
  keyOutline,
  mapOutline,
  lockClosedOutline,
  globeOutline,
  imagesOutline,
  moonOutline,
  phonePortraitOutline,
  playOutline,
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
import { ageLabel } from '../data/format';
import { loadTheme, loadVideoTap, type Theme, VIDEO_TAP_CHOICES, type VideoTap } from '../data/settings';
import {
  DEFAULT_THUMBNAIL_KEEP,
  deleteThumbnailsOlderThan,
  loadThumbnailKeep,
  megabytes,
  setThumbnailKeep,
  THUMBNAIL_KEEP_CHOICES,
  type ThumbnailKeep,
  thumbnailSpace,
} from '../data/thumbnails';
import { checkAppPassword, LOCK_AFTER_CHOICES, type LockAfter, readKeyring, removeBiometrics, setLockAfter } from '../data/vault';
import { midSentence } from '../ui/biometrics';
import { SHARE_ICON } from '../ui/icons';
import { canInstall, isIos } from '../ui/install';
import { resetEverything } from '../ui/reset';
import { useToast } from '../ui/toast';

type PasswordStep = { kind: 'export'; thenInstall?: boolean } | { kind: 'restore'; file: string };

export function SettingsPage() {
  const { db, api, gate, install, lock, sync, secretsShown } = useAppData();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [presentAlert] = useIonAlert();
  const [presentActionSheet] = useIonActionSheet();
  const showToast = useToast();
  const backupInput = useRef<HTMLInputElement>(null);
  const [contacting, setContacting] = useState(false);
  const [passwordStep, setPasswordStep] = useState<PasswordStep | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  // A backup opens with the app's password, when it has one, unless the user picks another one.
  const [appPassword, setUseAppPassword] = useState(true);
  const biometrics = useBiometricsFlow();
  const { confirmSecrets, secretLock, lockSecrets, lockApp, choosePassword } = useSecretFlow();
  // Redraws a choice the user cancelled or the device refused, so it shows the one still in force.
  const [lockChoiceDrawn, setLockChoiceDrawn] = useState(0);
  const [keepChoiceDrawn, setKeepChoiceDrawn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The install guide reopens once the backup it asked for is saved and the password dialog has gone.
  const reopenGuide = useRef(false);

  const theme = useLiveQuery(() => loadTheme(db), [db]) ?? 'system';
  const videoTap = useLiveQuery(() => loadVideoTap(db), [db]);
  const lastExportAt = useLiveQuery(() => getMeta<number>(db, 'lastExportAt'), [db]);
  const checksConnection = useLiveQuery(() => connectionCheckOn(db), [db]) ?? false;
  const keyring = useLiveQuery(() => readKeyring(db), [db]);
  const hasPassword = (keyring?.password ?? null) !== null;
  const biometricsOn = (keyring?.biometrics ?? null) !== null;
  // Locked when it asks; “never” opens without asking.
  const appLocked = keyring !== undefined && keyring.lockAfter !== 'never' && (hasPassword || biometricsOn);
  const secretsLocked = secretLock === 'app' || secretLock === 'pin';
  const how = biometricsOn && hasPassword ? `${midSentence(biometrics.verifiedBy)}, or your password` : biometricsOn ? midSentence(biometrics.verifiedBy) : 'your password';
  // Face ID that can't seal the data on this device only guards the door (vault.ts): said, with what closes it.
  const doorOnly = (keyring?.biometrics ?? null) !== null && keyring?.biometrics?.sealed === null;
  // One sentence, what is true now: who can open Subify, and what losing the lock costs.
  const lockExplained =
    biometricsOn && !hasPassword
      ? `Choose a password, in case ${midSentence(biometrics.verifiedBy)} stops working. Without either, only a backup brings your channels back.`
      : appLocked && doorOnly
        ? `Only ${how} opens Subify. But on this ${platformDevice()}, ${midSentence(biometrics.verifiedBy)} can’t encrypt it: a copy of the ${platformDevice()}’s data could still be read. Turn ${midSentence(biometrics.verifiedBy)} off, and your password protects that too.`
        : appLocked
        ? `Only ${how} opens Subify. If you forget the password, only a backup brings your channels back.`
        : `Subify’s data is encrypted, but anyone using your unlocked ${platformDevice()} can open it.`;

  const thumbnailKeep = useLiveQuery(() => loadThumbnailKeep(db), [db]) ?? DEFAULT_THUMBNAIL_KEEP;
  // Hidden secret channels stay out of the numbers, which would otherwise hint at them.
  const space = useLiveQuery(() => thumbnailSpace(db, secretsShown), [db, secretsShown]);

  const hasSecrets = useLiveQuery(async () => (await db.subscriptions.filter((channel) => channel.secret).count()) > 0, [db]);

  const toast = (message: string) => showToast(message, 2500);

  const openPassword = (step: PasswordStep) => {
    // A backup opens with a password its maker picks, and shows everything in it: saving one asks
    // first for what shows the secret channels, or the backup would show them to anyone holding the app.
    // The alert says why, and gives the tap the passkey needs to be asked for (Safari).
    // Without a lock there is nothing to ask: anyone holding the app can already show them.
    if (step.kind === 'export' && hasSecrets !== false && secretLock !== 'none') {
      void presentAlert({
        header: 'Unlock your secret channels',
        message: `The backup holds your secret channels too, and anyone with the file and its password can see them. Unlock them first, as you do to show them, so that no one else using your unlocked ${platformDevice()} can take them away in a backup.`,
        buttons: [
          { text: 'Cancel', role: 'cancel' },
          { text: 'Unlock', handler: () => void confirmSecrets().then((confirmed) => confirmed && askPassword(step)) },
        ],
      });

      return;
    }

    askPassword(step);
  };

  const askPassword = (step: PasswordStep) => {
    setPassword('');
    setRepeat('');
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

  // How the backup's secret channels come back: the app's lock stays on its device, a PIN of their own travels.
  const restoredSecrets = (backup: Backup) =>
    !backup.channels.some((channel) => channel.secret)
      ? ''
      : backup.secretCodeHash !== null
        ? ' Its secret channels stay hidden, behind the same PIN as on the device that saved it.'
        : ' Its secret channels stay hidden, and lock like Subify on this device, if you lock it.';

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
      if (passwordStep.kind === 'export') {
        if (appPassword) {
          const check = await checkAppPassword(db, password);

          if (!check.ok) {
            throw new BackupError(check.waitUntil === null ? 'That’s not the app’s password.' : `Too many tries. Wait ${Math.ceil((check.waitUntil - Date.now()) / 1000)} seconds.`);
          }

          // A backup leaves the device, where nothing makes a guesser wait: a PIN would fall at once.
          if (password.length < MINIMUM_PASSWORD_LENGTH) {
            throw new BackupError(`A backup leaves this device, so it needs a password of at least ${MINIMUM_PASSWORD_LENGTH} characters. Turn off “Use the app’s password” and choose one.`);
          }
        } else if (password !== repeat) {
          throw new BackupError('The two passwords are different.');
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

  const toggleBiometrics = async (on: boolean) => {
    // The password comes first: it opens Subify when Face ID can't.
    if (!hasPassword && !(await choosePassword())) {
      setLockChoiceDrawn((drawn) => drawn + 1);

      return;
    }

    if (on) {
      if (!(await biometrics.turnOn())) {
        setLockChoiceDrawn((drawn) => drawn + 1);
      }

      return;
    }

    await removeBiometrics(db);
    await db.meta.delete('secretCredential');
    // The passkey stays in the password manager, to be used again: nothing to delete there.
    await toast(`${biometrics.verifiedBy} off. Your password still works.`);
  };

  const keepSize = (keep: ThumbnailKeep) =>
    space === undefined ? '' : keep === 'always' ? ` · ${megabytes(space.perDay * 365)} a year` : ` · ${megabytes(space.perDay * keep)}`;

  // Keeping them longer loses nothing; keeping them shorter deletes at once, after a confirmation.
  const chooseKeep = (keep: ThumbnailKeep) => {
    const freed = keep === 'always' ? 0 : (space?.olderThan[keep] ?? 0);

    if (freed === 0) {
      void setThumbnailKeep(db, keep);

      return;
    }

    const label = THUMBNAIL_KEEP_CHOICES.find((choice) => choice.value === keep)!.label;
    void presentAlert({
      header: 'Delete older thumbnails?',
      message: `Keeping thumbnails for ${label} deletes the older ones now, ${megabytes(freed)}. They can’t come back: the app only gets thumbnails for the videos of the last 7 days.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: () => void setThumbnailKeep(db, keep).then(() => toast(`Freed ${megabytes(freed)}.`)) },
      ],
      onDidDismiss: (event) => event.detail.role !== 'destructive' && setKeepChoiceDrawn((drawn) => drawn + 1),
    });
  };

  // A one-off cleanup, under the time chosen: what it keeps from now on stays the same.
  const chooseCleanup = () => {
    const choices = THUMBNAIL_KEEP_CHOICES.flatMap(({ value, label }) =>
      value !== 'always' && (thumbnailKeep === 'always' || value < thumbnailKeep) && (space?.olderThan[value] ?? 0) > 0 ? [{ days: value, label, freed: space!.olderThan[value]! }] : [],
    );

    if (choices.length === 0) {
      void toast('No thumbnail older than a month to delete.');

      return;
    }

    void presentActionSheet({
      header: 'Delete thumbnails older than',
      buttons: [
        ...choices.map(({ days, label, freed }) => ({
          text: `${label} · ${megabytes(freed)}`,
          handler: () =>
            void presentAlert({
              header: `Delete thumbnails older than ${label}?`,
              message: `This frees ${megabytes(freed)}. They can’t come back: the app only gets thumbnails for the videos of the last 7 days.`,
              buttons: [
                { text: 'Cancel', role: 'cancel' },
                { text: 'Delete', role: 'destructive', handler: () => void deleteThumbnailsOlderThan(db, days).then(() => toast(`Freed ${megabytes(freed)}.`)) },
              ],
            }),
        })),
        { text: 'Cancel', role: 'cancel' },
      ],
    });
  };

  const toggle = (change: Promise<void>) => void change.finally(() => setLockChoiceDrawn((drawn) => drawn + 1));

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
            {passwordStep?.kind === 'export' ? 'Backup password' : 'Open the backup'}
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
            <IonItem>
              <IonInput
                label={passwordStep?.kind === 'export' && appPassword ? 'App password' : 'Password'}
                labelPlacement="stacked"
                type="password"
                autocomplete={passwordStep?.kind === 'restore' || appPassword ? 'current-password' : 'new-password'}
                value={password}
                onIonInput={(event) => setPassword(String(event.detail.value ?? ''))}
              />
            </IonItem>
            {passwordStep?.kind === 'export' && !appPassword && (
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
              {appPassword
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

      <Section heading="Videos" footer="The ⋯ menu of each video offers the other choices.">
        <IonItem lines="none">
          <IonIcon slot="start" icon={playOutline} aria-hidden="true" />
          <IonSelect
            label="Tap a video to"
            labelPlacement="stacked"
            interface="action-sheet"
            value={videoTap}
            onIonChange={(event) => void setMeta(db, 'videoTap', event.detail.value as VideoTap)}
          >
            {VIDEO_TAP_CHOICES.map(({ value, label }) => (
              <IonSelectOption key={value} value={value}>
                {label}
              </IonSelectOption>
            ))}
          </IonSelect>
        </IonItem>
      </Section>

      {/* The same rows whatever keeps the passkey, and whether there are secret channels: the screen tells nothing. */}
      <Section heading="Lock" footer={lockExplained}>
        <IonItem>
          <IonIcon slot="start" icon={lockClosedOutline} aria-hidden="true" />
          <IonToggle key={`app-${lockChoiceDrawn}`} checked={appLocked} onIonChange={(event) => toggle(lockApp(event.detail.checked))}>
            <IonLabel className="ion-text-wrap">
              <h2>Lock Subify</h2>
              <p>{appLocked ? `Asks for ${how}` : `Anyone using your unlocked ${platformDevice()} can open it`}</p>
            </IonLabel>
          </IonToggle>
        </IonItem>
        {appLocked && (
          <IonItem>
            <IonIcon slot="start" icon={timerOutline} aria-hidden="true" />
            <IonSelect
              key={lockChoiceDrawn}
              label="Ask to unlock"
              labelPlacement="stacked"
              interface="action-sheet"
              value={keyring?.lockAfter ?? 'open'}
              onIonChange={(event) => void setLockAfter(db, event.detail.value as LockAfter)}
            >
              {LOCK_AFTER_CHOICES.map(({ value, label }) => (
                <IonSelectOption key={String(value)} value={value}>
                  {label}
                </IonSelectOption>
              ))}
            </IonSelect>
          </IonItem>
        )}
        <IonItem>
          <IonIcon slot="start" icon={eyeOffOutline} aria-hidden="true" />
          <IonToggle key={`secrets-${lockChoiceDrawn}`} checked={secretsLocked} disabled={secretLock === undefined} onIonChange={(event) => toggle(lockSecrets(event.detail.checked))}>
            <IonLabel className="ion-text-wrap">
              <h2>Lock secret channels</h2>
              <p>{secretLock === 'pin' ? 'With their PIN, until you choose a password' : secretsLocked ? 'Asked each time you show them' : 'Hidden, but anyone using the open app can show them'}</p>
            </IonLabel>
          </IonToggle>
        </IonItem>
        {(biometrics.available || biometricsOn) && (
          <IonItem>
            <IonIcon slot="start" icon={fingerPrintOutline} aria-hidden="true" />
            <IonToggle key={`bio-${lockChoiceDrawn}`} checked={biometricsOn} onIonChange={(event) => void toggleBiometrics(event.detail.checked)}>
              <IonLabel className="ion-text-wrap">
                <h2>{biometrics.verifiedBy}</h2>
                <p>Instead of typing your password</p>
              </IonLabel>
            </IonToggle>
          </IonItem>
        )}
        <IonItem button detail={false} {...(appLocked ? {} : { lines: 'none' as const })} onClick={() => void choosePassword()}>
          <IonIcon slot="start" icon={keyOutline} aria-hidden="true" />
          <IonLabel className="ion-text-wrap">
            <h2>{hasPassword ? 'Change the password' : 'Choose a password'}</h2>
            <p>{hasPassword ? 'A PIN or a password' : 'Needed to lock: a PIN or a password'}</p>
          </IonLabel>
        </IonItem>
        {appLocked && (
          <IonItem button detail={false} lines="none" onClick={() => void lock()}>
            <IonIcon slot="start" icon={lockClosedOutline} aria-hidden="true" />
            <IonLabel>Lock now</IonLabel>
          </IonItem>
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
        footer="Before going online, the app shows which country the server sees you in, and waits for you to continue. Handy to check that your VPN is on."
      >
        <IonItem lines="none">
          <IonIcon slot="start" icon={globeOutline} aria-hidden="true" />
          <IonToggle checked={checksConnection} onIonChange={(event) => void setConnectionCheck(db, event.detail.checked)}>
            Check the connection first
          </IonToggle>
        </IonItem>
      </Section>

      <Section
        heading="Thumbnails"
        footer={`${space === undefined ? '' : `Thumbnails take ${megabytes(space.used)} on this device. `}The app only gets those of the last 7 days: once deleted, they don’t come back. Sizes are estimates for the channels you follow.`}
      >
        <IonItem {...(thumbnailKeep === DEFAULT_THUMBNAIL_KEEP ? { lines: 'none' as const } : {})}>
          <IonIcon slot="start" icon={imagesOutline} aria-hidden="true" />
          <IonSelect
            key={keepChoiceDrawn}
            label="Keep thumbnails"
            labelPlacement="stacked"
            interface="action-sheet"
            value={thumbnailKeep}
            // Said here: the select doesn't read its options again when their sizes change.
            selectedText={`${THUMBNAIL_KEEP_CHOICES.find((choice) => choice.value === thumbnailKeep)!.label}${keepSize(thumbnailKeep)}`}
            onIonChange={(event) => chooseKeep(event.detail.value as ThumbnailKeep)}
          >
            {THUMBNAIL_KEEP_CHOICES.map(({ value, label }) => (
              <IonSelectOption key={String(value)} value={value}>
                {`${label}${keepSize(value)}`}
              </IonSelectOption>
            ))}
          </IonSelect>
        </IonItem>
        {/* Under a month, nothing to clean: thumbnails already go after one. */}
        {thumbnailKeep !== DEFAULT_THUMBNAIL_KEEP && (
          <IonItem button detail={false} lines="none" onClick={chooseCleanup}>
            <IonIcon slot="start" icon={trashOutline} aria-hidden="true" />
            <IonLabel>Delete older thumbnails…</IonLabel>
          </IonItem>
        )}
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

function platformDevice(): 'phone' | 'computer' {
  return /iPhone|iPad|Android/.test(navigator.userAgent) || navigator.maxTouchPoints > 1 ? 'phone' : 'computer';
}
