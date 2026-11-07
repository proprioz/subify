import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonList,
  IonModal,
  IonNote,
  IonTitle,
  IonToolbar,
  useIonAlert,
} from '@ionic/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, type FormEvent, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getMeta, setMeta } from '../data/db';
import { beginSecretTour, checkSecretCode, forgetSecretChannels, secretUnlock } from '../data/secret';
import { guessTimeSentence, secondsToGuess, WEAK_BELOW_SECONDS } from '../data/strength';
import { changePassword, checkAppPassword, MINIMUM_PASSWORD_LENGTH, readKeyring, setLockAfter, setPassword } from '../data/vault';
import { midSentence, verifyBiometrics } from '../ui/biometrics';
import { useToast } from '../ui/toast';
import { useAppData } from './AppData';
import { useBiometricsFlow } from './BiometricsFlow';

/**
 * `create`, `change`: the app's password (a PIN is one too); `unlockApp`: entering it; `unlock`: a
 * PIN of secret channels' own, from earlier versions or a backup.
 */
type Step = 'create' | 'change' | 'unlock' | 'unlockApp';

/** What to do once the password is chosen or entered; `confirm` hears whether it went through. */
type Then = { show: true } | { confirm: (ok: boolean) => void } | null;

/**
 * What guards the secret channels: nothing (they are only out of sight), the app's lock (Face ID
 * or the app's password), or a PIN of their own. Undefined until read.
 */
export type SecretLock = 'none' | 'app' | 'pin';

/**
 * The short tour after the first channel made secret: where they show again (`reveal`: the
 * Channels tab's menu, a double tap on “All”), then, once shown without a lock, that one can be
 * added (`lock`).
 */
export type SecretTour = 'reveal' | 'lock' | null;

interface SecretFlow {
  /** Shows secret channels, after the lock if they have one. Hides them if they are shown. */
  toggleSecrets(): void;
  /** Asks for what shows secret channels, without showing them: true once it is given, or when nothing guards them. */
  confirmSecrets(): Promise<boolean>;
  /** Makes a channel secret, without asking for anything, or shows it like the others again. */
  setChannelSecret(key: string, secret: boolean): void;
  /** Locks secret channels with the app's lock, choosing its password first if it has none; or, once confirmed, no longer. */
  lockSecrets(on: boolean): Promise<void>;
  /** Locks Subify itself the same way; or lets it open without asking. */
  lockApp(on: boolean): Promise<void>;
  /** Chooses the app's password, or changes it. True once saved. */
  choosePassword(): Promise<boolean>;
  secretLock: SecretLock | undefined;
  tour: SecretTour;
  endTour(): void;
}

const SecretFlowContext = createContext<SecretFlow | null>(null);

/**
 * One lock for the app and its secret channels: Face ID / a fingerprint when the device has it,
 * and the app's password, required as soon as something locks, for when Face ID can't. This holds
 * the dialog that chooses, changes and asks for it. Secret channels hide again as soon as the app
 * leaves the screen (AppData).
 */
export function SecretFlowProvider({ children }: { children: ReactNode }) {
  const { db, secretsShown, setSecretsShown } = useAppData();
  const [presentAlert] = useIonAlert();
  const toast = useToast();
  const [step, setStep] = useState<Step | null>(null);
  const [then, setThen] = useState<Then>(null);
  const [code, setCode] = useState('');
  const [repeat, setRepeat] = useState('');
  const [current, setCurrent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const biometricsFlow = useBiometricsFlow();
  // Read before any tap: Safari asks for Face ID only while the tap is being handled, and a
  // database read before the request would let that moment pass.
  const keyring = useLiveQuery(() => readKeyring(db), [db]);
  // The device's one passkey; a passkey of secret channels' own, from earlier versions, still counts.
  const legacyCredential = useLiveQuery(async () => (await getMeta<string>(db, 'secretCredential')) ?? null, [db]);
  const credential = keyring?.biometrics?.credential ?? legacyCredential ?? null;
  const hasPassword = (keyring?.password ?? null) !== null;
  const chosen = useLiveQuery(() => secretUnlock(db), [db]);
  // Nothing may show without a lock before what guards them has been read.
  const secretLock: SecretLock | undefined =
    keyring === undefined || legacyCredential === undefined || chosen === undefined
      ? undefined
      : chosen === 'pin'
        ? 'pin'
        : chosen !== 'off' && (hasPassword || credential !== null)
          ? 'app'
          : 'none';
  const [tour, setTour] = useState<SecretTour>(null);

  // Shown during the tour: without a lock, its last step offers one; leaving them hides that offer too.
  useEffect(() => {
    if (secretsShown && tour === 'reveal') {
      setTour(secretLock === 'none' ? 'lock' : null);
    } else if (!secretsShown && tour === 'lock') {
      setTour(null);
    }
  }, [secretsShown, tour, secretLock]);

  // Resolved with false when the dialog closes without going through.
  const pendingConfirm = useRef<((ok: boolean) => void) | null>(null);

  const open = (next: Step, after: Then) => {
    setCode('');
    setRepeat('');
    setCurrent('');
    setError(null);
    setThen(after);
    setStep(next);
  };

  const close = () => {
    setStep(null);
    setThen(null);
  };

  const finish = useCallback(
    async (after: Then) => {
      if (after !== null && 'confirm' in after) {
        after.confirm(true);
      } else if (after !== null) {
        setSecretsShown(true);
      }
    },
    [setSecretsShown],
  );

  /** Opens a step and hears whether it went through. */
  const ask = (next: Step) =>
    new Promise<boolean>((resolve) => {
      const confirm = (ok: boolean) => {
        if (pendingConfirm.current === confirm) {
          pendingConfirm.current = null;
        }

        resolve(ok);
      };

      pendingConfirm.current = confirm;
      open(next, { confirm });
    });

  /** Asks for what shows secret channels, then does `after`: Face ID first, the password or the PIN if it doesn't confirm. */
  const unlock = (after: NonNullable<Then>) => {
    // Until the lock is read, nothing says what guards them: nothing shows, nothing is confirmed.
    if (secretLock === undefined) {
      if ('confirm' in after) {
        after.confirm(false);
      }

      return;
    }

    // Without a lock they are only out of sight: there is nothing to ask.
    if (secretLock === 'none') {
      void finish(after);

      return;
    }

    const fallBack = () => {
      if (secretLock === 'pin') {
        open('unlock', after);
      } else if (hasPassword) {
        open('unlockApp', after);
      } else {
        // Face ID alone, from before the password was required: it didn't confirm.
        if ('confirm' in after) {
          after.confirm(false);
        }

        void toast(`${biometricsFlow.verifiedBy} didn’t confirm it’s you.`);
      }
    };

    if (credential !== null) {
      void verifyBiometrics(credential).then((verified) => (verified ? finish(after) : fallBack()));

      return;
    }

    fallBack();
  };

  const toggleSecrets = () => {
    if (secretsShown) {
      setSecretsShown(false);
    } else {
      unlock({ show: true });
    }
  };

  const confirmSecrets = () =>
    new Promise<boolean>((resolve) => {
      const confirm = (ok: boolean) => {
        if (pendingConfirm.current === confirm) {
          pendingConfirm.current = null;
        }

        resolve(ok);
      };

      pendingConfirm.current = confirm;
      unlock({ confirm });
    });

  const choosePassword = () => ask(hasPassword ? 'change' : 'create');

  /**
   * What any lock needs: the app's password, for when Face ID can't, then Face ID if the device
   * has it (declined, the password alone locks).
   */
  const prepareLock = async (): Promise<boolean> => {
    if (!hasPassword && !(await choosePassword())) {
      return false;
    }

    if ((keyring?.biometrics ?? null) === null && biometricsFlow.available) {
      await biometricsFlow.turnOn();
    }

    return true;
  };

  const lockSecrets = async (on: boolean) => {
    if (on) {
      if (await prepareLock()) {
        await db.meta.bulkDelete(['secretCodeHash', 'secretLock']);
        await setMeta(db, 'secretUnlock', 'app');
        setTour(null);
        await toast('Secret channels locked.', 2000);
      }

      return;
    }

    // Anyone holding the open app could otherwise take the lock away.
    if (await confirmSecrets()) {
      await db.meta.bulkDelete(['secretCodeHash', 'secretLock']);
      await setMeta(db, 'secretUnlock', 'off');
      await toast('Anyone using the open app can now show your secret channels.', 2500);
    }
  };

  const lockApp = async (on: boolean) => {
    if (on) {
      if (await prepareLock()) {
        await setLockAfter(db, 'open');
        await toast('Subify now asks to unlock each time it opens.', 2500);
      }

      return;
    }

    await setLockAfter(db, 'never');
    await toast('Subify now opens without asking.', 2500);
  };

  const setChannelSecret = (key: string, secret: boolean) => {
    void (async () => {
      if (!secret) {
        await db.subscriptions.update(key, { secret: false });

        return;
      }

      const touring = await beginSecretTour(db);
      // The app's lock guards it at once, if it has one; otherwise it is only out of sight.
      await db.subscriptions.update(key, { secret: true });

      if (touring) {
        setTour('reveal');
      } else {
        await toast('Channel kept secret.', 1500);
      }
    })();
  };

  const tooMany = (waitUntil: number | null, wrong: string) => (waitUntil === null ? wrong : `Too many tries. Wait ${Math.ceil((waitUntil - Date.now()) / 1000)} seconds.`);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (step === 'unlockApp') {
      const result = await checkAppPassword(db, code);

      if (result.ok) {
        const after = then;
        close();
        await finish(after);
      } else {
        setError(tooMany(result.waitUntil, 'That’s not the password.'));
      }

      return;
    }

    if (step === 'unlock') {
      const result = await checkSecretCode(db, code);

      if (result.ok) {
        const after = then;
        close();
        await finish(after);
      } else {
        setError(tooMany(result.waitUntil, 'That’s not the PIN.'));
      }

      return;
    }

    if (code.length < MINIMUM_PASSWORD_LENGTH) {
      setError(`The password needs at least ${MINIMUM_PASSWORD_LENGTH} characters or digits.`);

      return;
    }

    if (code !== repeat) {
      setError('The two passwords are different.');

      return;
    }

    if (step === 'change') {
      const result = await changePassword(db, current, code);

      if (!result.ok) {
        setError(tooMany(result.waitUntil, 'That’s not the current password.'));

        return;
      }
    } else {
      await setPassword(db, code);
    }

    // The app's password replaces a PIN of secret channels' own.
    if (chosen === 'pin') {
      await db.meta.bulkDelete(['secretCodeHash', 'secretLock']);
      await setMeta(db, 'secretUnlock', 'app');
    }

    const after = then;
    close();
    await toast(step === 'change' ? 'Password changed.' : 'Password saved.', 1500);
    await finish(after);
  };

  /**
   * A forgotten password, asked while the app is open (secret channels, or changing it): as a
   * forgotten PIN, it removes the secret channels it guards, then a new one is chosen. Anyone holding
   * the open app could already reset it; this keeps the rest.
   */
  const forgetPassword = () => {
    void presentAlert({
      header: 'Forgot the password?',
      message: 'It can’t be recovered. You can remove every secret channel, with its videos, then choose a new password. Your other channels stay.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Remove secret channels',
          role: 'destructive',
          handler: () => {
            // Read now: `step` changes below. Changing it goes on, as choosing it; anything else was refused.
            const changing = step === 'change';
            void forgetSecretChannels(db).then(() => {
              if (!changing) {
                pendingConfirm.current?.(false);
              }

              setSecretsShown(false);
              open('create', changing ? then : null);
            });
          },
        },
      ],
    });
  };

  const forget = () => {
    void presentAlert({
      header: 'Forgot the PIN?',
      message: 'It can’t be recovered. The only way out is to remove every secret channel, with its videos. Your other channels stay.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Remove secret channels',
          role: 'destructive',
          handler: () => {
            void forgetSecretChannels(db).then(() => {
              close();
              setSecretsShown(false);
            });
          },
        },
      ],
    });
  };

  const useBiometrics = async () => {
    if (credential === null) {
      return;
    }

    setError(null);

    if (await verifyBiometrics(credential)) {
      const after = then;
      close();
      await finish(after);
    } else {
      setError(`${biometricsFlow.verifiedBy} didn’t confirm it’s you.`);
    }
  };

  const choosing = step === 'create' || step === 'change';
  const title = step === 'create' ? 'New password' : step === 'change' ? 'Password' : 'Secret channels';
  const field = (label: string, value: string, onChange: (value: string) => void, { autofocus = false, pin = false, fresh = false } = {}) => (
    <IonItem>
      <IonInput
        label={label}
        labelPlacement="stacked"
        type="password"
        inputmode={pin ? 'numeric' : 'text'}
        autocomplete={pin ? 'off' : fresh ? 'new-password' : 'current-password'}
        {...(pin ? { maxlength: 8 } : {})}
        value={value}
        autofocus={autofocus}
        onIonInput={(event) => onChange(String(event.detail.value ?? ''))}
      />
    </IonItem>
  );
  const weak = code.length > 0 && secondsToGuess(code) < WEAK_BELOW_SECONDS;

  return (
    <SecretFlowContext.Provider value={{ toggleSecrets, confirmSecrets, setChannelSecret, lockSecrets, lockApp, choosePassword, secretLock, tour, endTour: () => setTour(null) }}>
      {children}
      <IonModal
        isOpen={step !== null}
        onDidDismiss={() => {
          close();
          pendingConfirm.current?.(false);
        }}
        initialBreakpoint={0.75}
        breakpoints={[0, 0.75]}
      >
        <IonHeader>
          <IonToolbar>
            <IonButtons slot="start">
              <IonButton onClick={close}>Cancel</IonButton>
            </IonButtons>
            <IonTitle>{title}</IonTitle>
            <IonButtons slot="end">
              <IonButton strong type="submit" form="secret-code">
                {choosing ? 'Save' : then !== null && 'confirm' in then ? 'Unlock' : 'Show'}
              </IonButton>
            </IonButtons>
          </IonToolbar>
        </IonHeader>
        <IonContent>
          <form id="secret-code" onSubmit={(event) => void submit(event)}>
            <IonList inset>
              {step === 'unlockApp' && field('Password', code, setCode, { autofocus: true })}
              {step === 'unlock' && field('PIN', code, setCode, { autofocus: true, pin: true })}
              {step === 'change' && field('Current password', current, setCurrent, { autofocus: true })}
              {choosing && field(step === 'change' ? 'New password' : 'Password', code, setCode, { autofocus: step === 'create', fresh: true })}
              {choosing && field('Repeat the password', repeat, setRepeat, { fresh: true })}
            </IonList>
          </form>
          {error !== null && (
            <IonNote color="danger" className="ion-display-block ion-padding-horizontal" role="alert">
              {error}
            </IonNote>
          )}
          {choosing && (
            <div className="ion-padding-horizontal">
              {code.length > 0 && (
                <IonNote className={`ion-display-block ion-padding-bottom${weak ? ' strength-weak' : ''}`} aria-live="polite">
                  {guessTimeSentence(code)}
                  {weak ? ' A longer password, with letters, holds far longer.' : ''}
                </IonNote>
              )}
              <IonNote color="medium" className="ion-display-block">
                {`A PIN of ${MINIMUM_PASSWORD_LENGTH} digits or more, or any password. It opens Subify and your secret channels${
                  biometricsFlow.available ? ` when ${midSentence(biometricsFlow.verifiedBy)} can’t` : ''
                }. It can’t be recovered: forgotten, only a backup lets you start over.`}
              </IonNote>
            </div>
          )}
          {step === 'change' && (
            <div className="ion-padding">
              <IonButton expand="block" fill="clear" color="medium" onClick={forgetPassword}>
                Forgot the password?
              </IonButton>
            </div>
          )}
          {(step === 'unlock' || step === 'unlockApp') && (
            <div className="ion-padding">
              {credential !== null && (
                <IonButton expand="block" fill="outline" onClick={() => void useBiometrics()}>
                  Use {midSentence(biometricsFlow.verifiedBy)}
                </IonButton>
              )}
              <IonButton expand="block" fill="clear" color="medium" onClick={step === 'unlock' ? forget : forgetPassword}>
                {step === 'unlock' ? 'Forgot the PIN?' : 'Forgot the password?'}
              </IonButton>
            </div>
          )}
        </IonContent>
      </IonModal>
    </SecretFlowContext.Provider>
  );
}

export function useSecretFlow(): SecretFlow {
  const flow = useContext(SecretFlowContext);

  if (flow === null) {
    throw new Error('useSecretFlow must be used inside SecretFlowProvider.');
  }

  return flow;
}
