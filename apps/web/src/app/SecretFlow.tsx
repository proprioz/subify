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
import { createContext, type FormEvent, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { getMeta, setMeta } from '../data/db';
import { checkSecretCode, forgetSecretChannels, hasSecretCode, SECRET_CODE, secretUnlock, setSecretCode } from '../data/secret';
import { isAppPassword, readKeyring, unlockWithBiometrics } from '../data/vault';
import { biometricsAvailable, biometricsKey, enrollBiometrics, verifyBiometrics } from '../ui/biometrics';
import { useToast } from '../ui/toast';
import { useAppData } from './AppData';

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
  /** On once the device holds a credential; unavailable when the device has no Face ID or fingerprint to offer. */
  biometrics: 'on' | 'off' | 'unavailable';
  turnOnBiometrics(): void;
}

const SecretFlowContext = createContext<SecretFlow | null>(null);

const BIOMETRICS = 'Face ID or fingerprint';

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
  const [biometricsHere, setBiometricsHere] = useState(false);
  // Read before any tap: Safari asks for Face ID only while the tap is being handled, and a
  // database read before the request would let that moment pass.
  const credential = useLiveQuery(async () => (await getMeta<string>(db, 'secretCredential')) ?? null, [db]);
  const unlockWith = useLiveQuery(() => secretUnlock(db), [db]);
  const appBiometrics = useLiveQuery(async () => (await readKeyring(db))?.biometrics ?? null, [db]);

  useEffect(() => {
    void biometricsAvailable().then(setBiometricsHere);
  }, []);

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

  // Every way of turning biometrics on goes through this explanation: the device makes a passkey
  // and lets the user pick the password manager that keeps it.
  const turnOnBiometrics = useCallback(() => {
    void presentAlert({
      header: `Use ${BIOMETRICS}?`,
      message:
        'Show secret channels without typing the code. Subify makes a passkey for this: your device asks which password manager keeps it (Apple Passwords, Bitwarden or another one) and Subify’s server never sees it. The code keeps working. To stop, turn this off in the Channels tab’s ⋯ menu, then delete the passkey from your password manager.',
      buttons: [
        { text: 'Not now', role: 'cancel' },
        {
          text: `Use ${BIOMETRICS}`,
          handler: () => {
            void enrollBiometrics()
              .then(async (id) => {
                await setMeta(db, 'secretCredential', id);
                await toast(`${BIOMETRICS} turned on.`, 1500);
              })
              .catch(() => toast(`${BIOMETRICS} wasn’t turned on.`));
          },
        },
      ],
    });
  }, [db, toast, presentAlert]);

  /** Offers biometrics once, or again when a new code is chosen. */
  const offerBiometrics = async (again = false) => {
    if ((await getMeta(db, 'secretCredential')) !== undefined || (!again && (await getMeta(db, 'secretBiometricsOffered')) === true) || !(await biometricsAvailable())) {
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

    if (unlockWith === 'app') {
      open('unlockApp', { show: true });

      return;
    }

    // A credential only exists alongside a code.
    if (typeof credential === 'string') {
      void verifyBiometrics(credential).then((verified) => (verified ? setSecretsShown(true) : open('unlock', { show: true })));

      return;
    }

    void hasSecretCode(db).then((hasCode) => open(hasCode ? 'unlock' : 'choose', { show: true }));
  }, [db, credential, unlockWith, secretsShown, setSecretsShown]);

  const setChannelSecret = useCallback(
    (key: string, secret: boolean) => {
      void (async () => {
        if (!secret) {
          await db.subscriptions.update(key, { secret: false });
        } else if ((await secretUnlock(db)) !== null) {
          await finish({ secret: key });
        } else {
          open('choose', { secret: key });
        }
      })();
    },
    [db, finish],
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

  /** Secret channels unlock like the app: its password, or Face ID / a fingerprint when it has them. */
  const chooseAppPassword = async () => {
    await setMeta(db, 'secretUnlock', 'app');
    await db.meta.bulkDelete(['secretCodeHash', 'secretCredential', 'secretLock']);
    // Choosing it isn't proof of knowing it: the password is asked like at every unlock.
    open('unlockApp', then);
  };

  const useAppBiometrics = async () => {
    if (appBiometrics === null || appBiometrics === undefined) {
      return;
    }

    setError(null);
    const output = await biometricsKey(appBiometrics.credential, appBiometrics.salt);

    if (output !== null && (await unlockWithBiometrics(db, output))) {
      const after = then;
      close();
      await finish(after);
    } else {
      setError(`${BIOMETRICS} didn’t confirm it’s you.`);
    }
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
    if (typeof credential !== 'string') {
      return;
    }

    setError(null);

    if (await verifyBiometrics(credential)) {
      const after = then;
      close();
      await finish(after);
    } else {
      setError(`${BIOMETRICS} didn’t confirm it’s you.`);
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
        biometrics: unlockWith === 'app' ? 'unavailable' : typeof credential === 'string' ? 'on' : biometricsHere ? 'off' : 'unavailable',
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
              <IonButton expand="block" onClick={() => void chooseAppPassword()}>
                Use the app’s password
              </IonButton>
              <IonButton expand="block" fill="outline" onClick={() => open('create', then)}>
                Choose a shorter PIN
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
              4 to 8 digits, apart from the app’s password. A forgotten PIN can’t be recovered.
            </IonNote>
          )}
          {step === 'unlockApp' && appBiometrics !== null && appBiometrics !== undefined && (
            <div className="ion-padding">
              <IonButton expand="block" fill="outline" onClick={() => void useAppBiometrics()}>
                Use {BIOMETRICS}
              </IonButton>
            </div>
          )}
          {step === 'unlock' && (
            <div className="ion-padding">
              {typeof credential === 'string' && (
                <IonButton expand="block" fill="outline" onClick={() => void useBiometrics()}>
                  Use {BIOMETRICS}
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
