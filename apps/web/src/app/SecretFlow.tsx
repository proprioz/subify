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
import { beginSecretTour, checkSecretCode, forgetSecretChannels, SECRET_CODE, secretUnlock, setSecretCode } from '../data/secret';
import { isAppPassword, readKeyring } from '../data/vault';
import { verifyBiometrics } from '../ui/biometrics';
import { useToast } from '../ui/toast';
import { useAppData } from './AppData';
import { useBiometricsFlow } from './BiometricsFlow';

/** `choose`: the app's password or a PIN of their own; `unlockApp`: the app's password. */
type Step = 'choose' | 'create' | 'unlock' | 'unlockApp' | 'change';

/** What to do once the code is chosen or entered; `confirm` hears whether the unlock went through. */
type Then = { show: true } | { confirm: (ok: boolean) => void } | null;

/**
 * What guards the secret channels: nothing (they are only out of sight), the device's passkey,
 * the app's password, or a PIN of their own. Undefined until read.
 */
export type SecretLock = 'none' | 'passkey' | 'password' | 'pin';

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
  /** Chooses, or changes, what secret channels unlock with. */
  chooseLock(): void;
  secretLock: SecretLock | undefined;
  tour: SecretTour;
  endTour(): void;
  /** On once the device's passkey is on (Settings, Lock); unavailable when the device has no Face ID or fingerprint to offer. */
  biometrics: 'on' | 'off' | 'unavailable';
  turnOnBiometrics(): void;
}

const SecretFlowContext = createContext<SecretFlow | null>(null);

/**
 * The secret code dialog and everything around it: choosing the code, entering it, offering
 * biometrics after the first unlock, changing it, and forgetting it (which removes the secret
 * channels). Secret channels hide again as soon as the app leaves the screen (AppData).
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
  // “The app's lock” with nothing left to unlock it (Face ID turned off, no password): no lock.
  const unlockWith = chosen === 'app' && !hasPassword && credential === null ? null : chosen;
  // Nothing may show without a lock before what guards them has been read.
  const secretLock: SecretLock | undefined =
    keyring === undefined || legacyCredential === undefined || unlockWith === undefined
      ? undefined
      : unlockWith === 'pin'
        ? 'pin'
        : credential !== null
          ? 'passkey'
          : unlockWith === 'app'
            ? 'password'
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

  // Face ID is one setting for the whole app (Settings, Lock): turned on here, it is on there too.
  const turnOnBiometrics = useCallback(() => void biometricsFlow.turnOn(), [biometricsFlow]);

  /** Offers biometrics once, or again when a new code is chosen. */
  const offerBiometrics = async (again = false) => {
    if (credential !== null || (!again && (await getMeta(db, 'secretBiometricsOffered')) === true) || !biometricsFlow.available) {
      return;
    }

    await setMeta(db, 'secretBiometricsOffered', true);
    turnOnBiometrics();
  };

  /** Asks for what shows secret channels, then does `after`. */
  const unlock = useCallback(
    (after: NonNullable<Then>) => {
      const refuse = () => {
        if ('confirm' in after) {
          after.confirm(false);
        }

        void toast('The passkey didn’t confirm it’s you.');
      };

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

      if (unlockWith === null || unlockWith === undefined) {
        // A passkey already on is the way: no choice to make, the device asks for it.
        void verifyBiometrics(credential!).then(async (verified) => {
          if (verified) {
            await setMeta(db, 'secretUnlock', 'app');
            await finish(after);
          } else {
            refuse();
          }
        });

        return;
      }

      // Face ID first, whichever way they unlock; the password or the PIN if it doesn't confirm.
      const fallBack = () => (unlockWith === 'app' ? (hasPassword ? open('unlockApp', after) : refuse()) : open('unlock', after));

      if (credential !== null) {
        void verifyBiometrics(credential).then((verified) => (verified ? finish(after) : fallBack()));

        return;
      }

      fallBack();
    },
    [db, credential, unlockWith, hasPassword, secretLock, finish, toast],
  );

  const toggleSecrets = useCallback(() => {
    if (secretsShown) {
      setSecretsShown(false);
    } else {
      unlock({ show: true });
    }
  }, [secretsShown, setSecretsShown, unlock]);

  // Resolved with false when the dialog closes without the unlock going through.
  const pendingConfirm = useRef<((ok: boolean) => void) | null>(null);

  const confirmSecrets = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        const confirm = (ok: boolean) => {
          if (pendingConfirm.current === confirm) {
            pendingConfirm.current = null;
          }

          resolve(ok);
        };

        pendingConfirm.current = confirm;
        unlock({ confirm });
      }),
    [unlock],
  );

  const setChannelSecret = useCallback(
    (key: string, secret: boolean) => {
      void (async () => {
        if (!secret) {
          await db.subscriptions.update(key, { secret: false });

          return;
        }

        // Read before the passkey becomes their lock below: a lock already chosen means they're known.
        const touring = await beginSecretTour(db);

        if ((unlockWith === null || unlockWith === undefined) && credential !== null) {
          // Hiding a channel shows nothing: the passkey already on guards it, without asking.
          await setMeta(db, 'secretUnlock', 'app');
        }

        // Without a lock, the channel is only out of sight: one can be added now or later (chooseLock).
        await db.subscriptions.update(key, { secret: true });

        if (touring) {
          setTour('reveal');
        } else {
          await toast('Channel kept secret.', 1500);
        }
      })();
    },
    [db, toast, unlockWith, credential],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (step === 'unlockApp') {
      if (await isAppPassword(db, code)) {
        const after = then;
        close();
        await finish(after);
      } else {
        setError('That’s not the app’s password.');
      }

      return;
    }

    if (step === 'unlock' || step === 'change') {
      const typed = step === 'unlock' ? code : current;
      const result = await checkSecretCode(db, typed);

      if (!result.ok) {
        setError(result.waitUntil === null ? 'That’s not the PIN.' : `Too many tries. Wait ${Math.ceil((result.waitUntil - Date.now()) / 1000)} seconds.`);

        return;
      }

      if (step === 'unlock') {
        close();
        await finish(then);
        await offerBiometrics();

        return;
      }
    }

    if (!SECRET_CODE.test(code)) {
      setError('The PIN has 4 to 8 digits.');

      return;
    }

    if (code !== repeat) {
      setError('The two PINs are different.');

      return;
    }

    await setSecretCode(db, code);
    await setMeta(db, 'secretUnlock', 'pin');
    const after = then;
    close();
    await toast(step === 'change' ? 'PIN changed.' : 'PIN saved.', 1500);
    await finish(after);

    if (step === 'create') {
      await offerBiometrics(true);
    }
  };

  /** Secret channels unlock like the app: Face ID / a fingerprint, or its password. */
  const chooseAppLock = async () => {
    // The device is asked first, while the tap is being handled; the database waits.
    if (credential !== null) {
      // Choosing it isn't proof: the device asks, like at every unlock.
      if (await verifyBiometrics(credential)) {
        await db.meta.bulkDelete(['secretCodeHash', 'secretLock']);
        await setMeta(db, 'secretUnlock', 'app');
        const after = then;
        close();
        await finish(after);
      } else {
        setError('The passkey didn’t confirm it’s you.');
      }

      return;
    }

    // Turning it on asks the device, which is proof enough.
    if (await biometricsFlow.turnOn()) {
      await db.meta.bulkDelete(['secretCodeHash', 'secretLock']);
      await setMeta(db, 'secretUnlock', 'app');
      const after = then;
      close();
      await finish(after);
    }
  };

  const chooseAppPassword = async () => {
    await setMeta(db, 'secretUnlock', 'app');
    await db.meta.bulkDelete(['secretCodeHash', 'secretLock']);
    // Choosing it isn't proof of knowing it: the password is asked like at every unlock.
    open('unlockApp', then);
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
      setError('The passkey didn’t confirm it’s you.');
    }
  };

  const title = step === 'choose' ? (secretLock === 'none' ? 'Add a lock' : 'Change the lock') : step === 'create' ? 'Choose a PIN' : step === 'change' ? 'Change the PIN' : 'Secret channels';
  const field = (label: string, value: string, onChange: (value: string) => void, autofocus = false, pin = true) => (
    <IonItem>
      <IonInput
        label={label}
        labelPlacement="stacked"
        type="password"
        inputmode={pin ? 'numeric' : 'text'}
        autocomplete={pin ? 'off' : 'current-password'}
        {...(pin ? { maxlength: 8 } : {})}
        value={value}
        autofocus={autofocus}
        onIonInput={(event) => onChange(String(event.detail.value ?? ''))}
      />
    </IonItem>
  );

  return (
    <SecretFlowContext.Provider
      value={{
        toggleSecrets,
        confirmSecrets,
        setChannelSecret,
        chooseLock: () => {
          setTour(null);
          open('choose', null);
        },
        secretLock,
        tour,
        endTour: () => setTour(null),
        biometrics: credential !== null ? 'on' : biometricsFlow.available ? 'off' : 'unavailable',
        turnOnBiometrics,
      }}
    >
      {children}
      <IonModal
        isOpen={step !== null}
        onDidDismiss={() => {
          close();
          pendingConfirm.current?.(false);
        }}
        initialBreakpoint={0.75} breakpoints={[0, 0.75]}>
        <IonHeader>
          <IonToolbar>
            <IonButtons slot="start">
              <IonButton onClick={close}>Cancel</IonButton>
            </IonButtons>
            <IonTitle>{title}</IonTitle>
            {step !== 'choose' && (
              <IonButtons slot="end">
                <IonButton strong type="submit" form="secret-code">
                  {step === 'unlock' || step === 'unlockApp' ? (then !== null && 'confirm' in then ? 'Unlock' : 'Show') : 'Save'}
                </IonButton>
              </IonButtons>
            )}
          </IonToolbar>
        </IonHeader>
        <IonContent>
          {step === 'choose' ? (
            <div className="ion-padding">
              <IonNote color="medium" className="ion-display-block ion-padding-bottom">
                Choose what showing your secret channels asks for. They still hide again when you leave the screen.
              </IonNote>
              {(credential !== null || biometricsFlow.available) && (
                <IonButton expand="block" onClick={() => void chooseAppLock()}>
                  Use your passkey
                </IonButton>
              )}
              {hasPassword && (
                <IonButton expand="block" fill={credential !== null || biometricsFlow.available ? 'outline' : 'solid'} onClick={() => void chooseAppPassword()}>
                  Use the app’s password
                </IonButton>
              )}
              <IonButton expand="block" fill="outline" onClick={() => open('create', then)}>
                {hasPassword || credential !== null || biometricsFlow.available ? 'Choose a PIN instead' : 'Choose a PIN'}
              </IonButton>
            </div>
          ) : (
            <form id="secret-code" onSubmit={(event) => void submit(event)}>
              <IonList inset>
                {step === 'unlockApp' && field('App password', code, setCode, true, false)}
                {step === 'change' && field('Current PIN', current, setCurrent, true)}
                {step !== 'unlockApp' && field(step === 'unlock' ? 'PIN' : step === 'change' ? 'New PIN' : 'PIN', code, setCode, step !== 'change')}
                {(step === 'create' || step === 'change') && field('Repeat the PIN', repeat, setRepeat)}
              </IonList>
            </form>
          )}
          {error !== null && (
            <IonNote color="danger" className="ion-display-block ion-padding-horizontal" role="alert">
              {error}
            </IonNote>
          )}
          {step === 'create' && (
            <IonNote color="medium" className="ion-display-block ion-padding-horizontal">
              4 to 8 digits, apart from the app’s lock. A forgotten PIN can’t be recovered.
            </IonNote>
          )}
          {step === 'unlockApp' && credential !== null && (
            <div className="ion-padding">
              <IonButton expand="block" fill="outline" onClick={() => void useBiometrics()}>
                Use your passkey
              </IonButton>
            </div>
          )}
          {step === 'unlock' && (
            <div className="ion-padding">
              {credential !== null && (
                <IonButton expand="block" fill="outline" onClick={() => void useBiometrics()}>
                  Use your passkey
                </IonButton>
              )}
              <IonButton expand="block" fill="clear" color="medium" onClick={forget}>
                Forgot the PIN?
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
