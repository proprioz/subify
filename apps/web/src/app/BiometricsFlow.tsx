import { IonButton, IonContent, IonItem, IonLabel, IonList, IonModal, IonNote, useIonAlert } from '@ionic/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getMeta, setMeta } from '../data/db';
import { addBiometrics, readKeyring, rememberPasskey } from '../data/vault';
import { askPasskey, biometricsAvailable, biometricsLabel, createPasskey, deviceName, type Enrolled, midSentence, type Platform, thisPlatform } from '../ui/biometrics';
import { useToast } from '../ui/toast';
import { useAppData } from './AppData';

interface BiometricsFlow {
  /** How the passkey checks it's the user on this device: “Face ID or Touch ID”, “Windows Hello”… */
  verifiedBy: string;
  /** Whether this device can offer it at all. */
  available: boolean;
  /** Explains, then turns Face ID on with the device's one passkey. True once it is on. */
  turnOn(): Promise<boolean>;
}

const BiometricsFlowContext = createContext<BiometricsFlow | null>(null);

/** Below this, a passkey that didn't answer never showed its sheet: it was deleted from the password manager. */
const NO_SHEET_MS = 1000;

/**
 * Turning Face ID / a fingerprint on, wherever it starts (Settings, secret channels): the same
 * explanation, the same passkey for the device, reused when it was turned off before, and a guide
 * when the device has nowhere to keep one.
 */
export function BiometricsFlowProvider({ children }: { children: ReactNode }) {
  const { db } = useAppData();
  const [presentAlert] = useIonAlert();
  const toast = useToast();
  const [platform] = useState<Platform>(thisPlatform);
  const [available, setAvailable] = useState(false);
  const [guide, setGuide] = useState<{
    retry(): void;
    done(on: boolean): void;
  } | null>(null);
  // Read before any tap: Safari asks for Face ID only while the tap is being handled, and a
  // database read before the request would let that moment pass.
  const keyring = useLiveQuery(() => readKeyring(db), [db]);
  const passkeyUser = useLiveQuery(async () => (await getMeta<Uint8Array>(db, 'passkeyUser')) ?? null, [db]);
  // What an alert's buttons read when tapped, not what it was when the alert opened.
  const latest = useRef({ keyring, passkeyUser });
  latest.current = { keyring, passkeyUser };
  const verifiedBy = biometricsLabel(platform);
  const device = deviceName(navigator.userAgent, navigator.maxTouchPoints);

  useEffect(() => {
    void biometricsAvailable().then(setAvailable);
  }, []);

  // One user id per device: a password manager that meets it again replaces the passkey.
  useEffect(() => {
    if (passkeyUser === null) {
      void setMeta(db, 'passkeyUser', crypto.getRandomValues(new Uint8Array(16)));
    }
  }, [db, passkeyUser]);

  /**
   * The passkey this device already has, else a new one; `fresh` makes a new one anyway. Must run
   * first thing in the tap. `unconfirmed`: a passkey exists but didn't answer, missing or out of sight.
   */
  const enroll = useCallback(async (fresh: boolean): Promise<Enrolled | 'cancelled' | 'unavailable' | 'unconfirmed'> => {
    const { keyring, passkeyUser } = latest.current;
    const kept = fresh ? undefined : keyring?.passkey;

    if (kept !== undefined) {
      const started = performance.now();
      const used = await askPasskey(kept.credential, kept.salt);

      if (used !== null) {
        return {
          credential: kept.credential,
          salt: kept.salt,
          output: used.output,
        };
      }

      // The sheet showed: the passkey is out of sight (another password manager) or deleted.
      if (performance.now() - started >= NO_SHEET_MS) {
        return 'unconfirmed';
      }
    }

    const created = await createPasskey(passkeyUser ?? crypto.getRandomValues(new Uint8Array(16)));

    // Saved in the password manager from now on, used or not: Settings names it.
    if (typeof created === 'object' && created.name !== undefined) {
      await setMeta(db, 'passkeyName', created.name);
    }

    if (typeof created === 'object' && 'unconfirmed' in created) {
      await rememberPasskey(db, created.credential, created.salt);

      return 'unconfirmed';
    }

    return created;
  }, [db]);

  const attempt = useCallback(
    (done: (on: boolean) => void, fresh = false) => {
      void (async () => {
        const result = await enroll(fresh);
        const name = await getMeta<string>(db, 'passkeyName');

        // Never a dead end: the same passkey again, through its password manager, or a new one.
        if (result === 'unconfirmed') {
          void presentAlert({
            header: 'The passkey didn’t answer',
            message: `If the list said no passkey is saved for this website, Subify’s passkey is in another password manager: tap Try again, then “More from…” at the bottom, and pick ${
              name === undefined ? 'it' : `“${name}”`
            }. If you deleted it, make a new one.`,
            buttons: [
              { text: 'Try again', handler: () => attempt(done) },
              { text: 'Make a new passkey', handler: () => attempt(done, true) },
              { text: 'Cancel', role: 'cancel', handler: () => done(false) },
            ],
          });

          return;
        }

        if (result === 'unavailable') {
          setGuide({ retry: () => attempt(done), done });

          return;
        }

        if (result === 'cancelled') {
          await toast('The passkey wasn’t turned on.', 2500);
          done(false);

          return;
        }

        // Whatever keeps the passkey, it does the same: with a key, it seals the app's; without, it
        // guards the key the device keeps (vault.ts). What locks is chosen in Settings, Lock.
        await addBiometrics(db, result.credential, result.salt, result.output);
        // Secret channels' own passkey, from earlier versions: this one replaces it.
        await db.meta.delete('secretCredential');
        await toast(`${verifiedBy} on. Your password still works.`, 2500);
        done(true);
      })();
    },
    [db, enroll, presentAlert, toast, verifiedBy],
  );

  const turnOn = useCallback(
    () =>
      new Promise<boolean>((done) => {
        const reused = keyring?.passkey !== undefined;

        void presentAlert({
          header: `Use ${midSentence(verifiedBy)}?`,
          message: [
            // On Android it stays on the phone, in no password manager: there is nothing to explain.
            platform === 'android' ? null : 'Subify saves a passkey for it.',
            reused ? `It uses what this ${device} already has: nothing new is saved.` : keeps(platform, device),
            'Subify’s server never sees it. Your password keeps working.',
          ]
            .filter((sentence) => sentence !== null)
            .join(' '),
          buttons: [
            { text: 'Not now', role: 'cancel', handler: () => done(false) },
            { text: 'Continue', handler: () => attempt(done) },
          ],
        });
      }),
    [attempt, device, keyring, platform, presentAlert, verifiedBy],
  );

  const steps = GUIDES[platform](device);

  return (
    <BiometricsFlowContext.Provider value={{ verifiedBy, available, turnOn }}>
      {children}
      <IonModal
        isOpen={guide !== null}
        onDidDismiss={() => {
          // Swiped away: the attempt ends there.
          if (guide !== null) {
            setGuide(null);
            guide.done(false);
          }
        }}
      >
        <IonContent className="ion-padding">
          <div className="ion-text-center">
            <h2>{steps.title}</h2>
            <IonNote color="medium" className="ion-display-block">
              No passkey was saved. {steps.lead}
            </IonNote>
          </div>
          <IonList inset>
            {steps.steps.map((step, index) => (
              <IonItem key={index} {...(index === steps.steps.length - 1 ? { lines: 'none' as const } : {})}>
                <IonNote slot="start">{index + 1}</IonNote>
                <IonLabel className="ion-text-wrap install-step">{step}</IonLabel>
              </IonItem>
            ))}
          </IonList>
          {steps.note !== undefined && (
            <IonNote color="medium" className="ion-display-block ion-padding-horizontal ion-padding-bottom ion-text-center">
              {steps.note}
            </IonNote>
          )}
          <IonButton
            expand="block"
            onClick={() => {
              // Tried from the tap itself: the device asks only while it is handled.
              const retry = guide?.retry;
              setGuide(null);
              retry?.();
            }}
          >
            Try again
          </IonButton>
          <IonButton
            expand="block"
            fill="clear"
            color="medium"
            onClick={() => {
              const shown = guide;
              setGuide(null);
              shown?.done(false);
            }}
          >
            Not now
          </IonButton>
        </IonContent>
      </IonModal>
    </BiometricsFlowContext.Provider>
  );
}

export function useBiometricsFlow(): BiometricsFlow {
  const flow = useContext(BiometricsFlowContext);

  if (flow === null) {
    throw new Error('useBiometricsFlow must be used inside BiometricsFlowProvider.');
  }

  return flow;
}

/** Where the key goes, named the way the device names it. */
function keeps(platform: Platform, device: string): string {
  switch (platform) {
    case 'ios':
      return `Your ${device} keeps it in Passwords, the app built into iOS: there’s nothing to install.`;
    case 'mac':
      return 'Your Mac keeps it in Passwords, built into macOS: there’s nothing to install.';
    case 'android':
      return 'It stays on this phone: there’s nothing to install.';
    case 'windows':
      return 'Windows keeps it on this computer: there’s nothing to install.';
    case 'other':
      return 'Your device keeps it in its password manager.';
  }
}

type Guide = { title: string; lead: string; steps: ReactNode[]; note?: string };

const BACK = (
  <>
    Come back to Subify and tap <b>Try again</b>.
  </>
);

/** What to turn on when the device showed no sheet: a web page can't open the system's settings. */
const GUIDES: Record<Platform, (device: string) => Guide> = {
  ios: (device) => ({
    title: 'Turn on Passwords',
    lead: `Most of the time, Passwords is off on this ${device}. It’s built into iOS: there’s nothing to install.`,
    steps: [
      <>
        Open <b>Settings</b> on your {device}.
      </>,
      <>
        Tap <b>General</b>, then <b>AutoFill &amp; Passwords</b>.
      </>,
      <>
        Turn on <b>AutoFill Passwords and Passkeys</b>, with <b>Passwords</b> ticked.
      </>,
      BACK,
    ],
    note: 'Already using another password manager? It works too, if it’s ticked in that same list.',
  }),
  mac: () => ({
    title: 'Turn on Passwords',
    lead: 'Most of the time, Passwords is off on this Mac. It’s built into macOS: there’s nothing to install.',
    steps: [
      <>
        Open <b>System Settings</b>.
      </>,
      <>
        Click <b>General</b>, then <b>AutoFill &amp; Passwords</b>.
      </>,
      <>
        Turn on <b>AutoFill Passwords and Passkeys</b>, with <b>Passwords</b> ticked.
      </>,
      BACK,
    ],
    note: 'Already using another password manager? It works too, if it’s ticked in that same list.',
  }),
  android: () => ({
    title: 'Choose where passkeys go',
    lead: 'Most of the time, no passkey service is chosen on this phone. Google Password Manager is built into Android: there’s nothing to install.',
    steps: [
      <>
        Open <b>Settings</b> on your phone.
      </>,
      <>
        Tap <b>Passwords, passkeys &amp; accounts</b>. If you can’t find it, search Settings for “passkeys”.
      </>,
      <>
        Choose <b>Google</b> as the preferred service.
      </>,
      BACK,
    ],
    note: 'Already using another password manager? Choose it instead: it works too.',
  }),
  windows: () => ({
    title: 'Set up Windows Hello',
    lead: 'Windows Hello isn’t set up on this computer yet. It’s built into Windows: there’s nothing to install.',
    steps: [
      <>
        Open <b>Settings</b>.
      </>,
      <>
        Go to <b>Accounts</b>, then <b>Sign-in options</b>.
      </>,
      <>
        Set up <b>Facial recognition</b>, <b>Fingerprint</b> or a <b>PIN</b>.
      </>,
      BACK,
    ],
  }),
  other: () => ({
    title: 'No place for the key',
    lead: 'This device keeps no passkeys yet. Turn on its password manager’s passkeys, then try again.',
    steps: ['Open the device’s settings.', 'Find its passwords and passkeys.', 'Turn passkeys on.', BACK],
  }),
};
