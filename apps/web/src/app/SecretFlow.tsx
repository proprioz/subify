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
import { createContext, type FormEvent, type ReactNode, useCallback, useContext, useState } from 'react';
import { getMeta, setMeta } from '../data/db';
import { checkSecretCode, forgetSecretChannels, SECRET_CODE, secretUnlock, setSecretCode } from '../data/secret';
import { isAppPassword, readKeyring } from '../data/vault';
import { verifyBiometrics } from '../ui/biometrics';
import { useToast } from '../ui/toast';
import { useAppData } from './AppData';
import { useBiometricsFlow } from './BiometricsFlow';

/** `choose`: the app's password or a PIN of their own; `unlockApp`: the app's password. */
type Step = 'choose' | 'create' | 'unlock' | 'unlockApp' | 'change';

/** What to do once the code is chosen or entered. */
type Then = { show: true } | { secret: string } | null;

interface SecretFlow {
  /** Shows secret channels, after the code or biometrics. Hides them if they are shown. */
  toggleSecrets(): void;
  /** Makes a channel secret, choosing a code first if there is none yet, or shows it like the others again. */
  setChannelSecret(key: string, secret: boolean): void;
  changeCode(): void;
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
  // “The app's lock” with nothing left to unlock it (Face ID turned off, no password): choose again.
  const unlockWith = chosen === 'app' && !hasPassword && credential === null ? null : chosen;

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
      if (after !== null && 'secret' in after) {
        await db.subscriptions.update(after.secret, { secret: true });
        await toast('Channel kept secret.', 1500);
      } else if (after !== null) {
        setSecretsShown(true);
      }
    },
    [db, toast, setSecretsShown],
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

  const toggleSecrets = useCallback(() => {
    if (secretsShown) {
      setSecretsShown(false);

      return;
    }

    if (unlockWith === null || unlockWith === undefined) {
      open('choose', { show: true });

      return;
    }

    // Face ID first, whichever way they unlock; the password or the PIN if it doesn't confirm.
    const fallBack = () => (unlockWith === 'app' ? (hasPassword ? open('unlockApp', { show: true }) : void toast('The passkey didn’t confirm it’s you.')) : open('unlock', { show: true }));

    if (credential !== null) {
      void verifyBiometrics(credential).then((verified) => (verified ? setSecretsShown(true) : fallBack()));

      return;
    }

    fallBack();
  }, [credential, unlockWith, hasPassword, secretsShown, setSecretsShown, toast]);

  const setChannelSecret = useCallback(
    (key: string, secret: boolean) => {
      void (async () => {
        if (!secret) {
          await db.subscriptions.update(key, { secret: false });
        } else if (unlockWith !== null && unlockWith !== undefined) {
          await finish({ secret: key });
        } else {
          open('choose', { secret: key });
        }
      })();
    },
    [db, finish, unlockWith],
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

  const title = step === 'choose' ? 'Unlock secret channels' : step === 'create' ? 'Choose a PIN' : step === 'change' ? 'Change the PIN' : 'Secret channels';
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
        setChannelSecret,
        changeCode: () => open('choose', null),
        biometrics: credential !== null ? 'on' : biometricsFlow.available ? 'off' : 'unavailable',
        turnOnBiometrics,
      }}
    >
      {children}
      <IonModal isOpen={step !== null} onDidDismiss={close} initialBreakpoint={0.75} breakpoints={[0, 0.75]}>
        <IonHeader>
          <IonToolbar>
            <IonButtons slot="start">
              <IonButton onClick={close}>Cancel</IonButton>
            </IonButtons>
            <IonTitle>{title}</IonTitle>
            {step !== 'choose' && (
              <IonButtons slot="end">
                <IonButton strong type="submit" form="secret-code">
                  {step === 'unlock' || step === 'unlockApp' ? 'Show' : 'Save'}
                </IonButton>
              </IonButtons>
            )}
          </IonToolbar>
        </IonHeader>
        <IonContent>
          {step === 'choose' ? (
            <div className="ion-padding">
              <IonNote color="medium" className="ion-display-block ion-padding-bottom">
                Secret channels and their videos only show once you unlock them, and hide again when you leave the app.
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
