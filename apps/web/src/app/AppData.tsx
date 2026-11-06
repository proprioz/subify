import { useIonAlert, useIonToast } from '@ionic/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { close } from 'ionicons/icons';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Api, ServerError } from '../data/api';
import { type AskConnection, CONNECTION_TRUSTS, ConnectionGate, type ConnectionTrust, isCancelled } from '../data/connection-check';
import { SubifyDb } from '../data/db';
import { refreshDictionary } from '../data/dictionary';
import { runImportQueue } from '../data/follow-many';
import { countryFlag, countryName } from '../data/format';
import { loadTheme } from '../data/settings';
import { unfinishedSync } from '../data/encrypted';
import { syncToTheEnd, syncUpdates, type Visibility } from '../data/sync';
import { dropOldThumbnails } from '../data/thumbnails';
import { forgetKeptKey, LockedError, lockVault, readKeyring, startVault } from '../data/vault';
import { applyTheme } from '../theme/palette';
import { appReplaced, onAppReplaced, updateApp } from '../ui/app-update';
import { type InstallState, installState } from '../ui/install';
import { toastPlacement } from '../ui/toast';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Where the app's password stands: being read, to choose, to enter, or entered. */
export type VaultState = 'starting' | 'setup' | 'locked' | 'open';

interface AppData {
  db: SubifyDb;
  vault: VaultState;
  /** The password was chosen or entered: the app shows. */
  vaultOpened(): void;
  /** Locks the app now, whatever the user chose: it asks for the password at once and after a relaunch. */
  lock(): Promise<void>;
  /** The server's client. Every step that uses it runs through `gate`. */
  api: Api;
  /** The connection check: `gate.run(api, step)` asks first when Settings says so. */
  gate: ConnectionGate;
  /**
   * Runs a sync, or joins the one already running. `continuing` carries on the approved step
   * running now (a restore), without asking again; call it before that step ends.
   */
  sync(continuing?: boolean): Promise<void>;
  syncing: boolean;
  /** How far the running sync got, in percent, when it reads several pages; 0 otherwise. */
  syncDone: number;
  syncError: string | null;
  /** Whether secret channels are shown. Never saved: they hide again on another screen, or when the app leaves the screen. */
  secretsShown: boolean;
  setSecretsShown(shown: boolean): void;
  /** The secret channel opened on its own from the list: the feed shows it, without the others, until the app leaves the screen or the feed. */
  secretOpened: string | null;
  setSecretOpened(key: string | null): void;
  install: InstallState;
  /** Opens the browser's own install dialog, when `install` is `prompt`. */
  promptInstall(): Promise<void>;
  /** Whether the browser promised to keep the database (`navigator.storage.persist()`); undefined until it answers. */
  storageKept: boolean | undefined;
}

const AppDataContext = createContext<AppData | null>(null);

const documentVisibility: Visibility = {
  visible: () => document.visibilityState === 'visible',
  onChange: (listener) => {
    document.addEventListener('visibilitychange', listener);

    return () => document.removeEventListener('visibilitychange', listener);
  },
};

/** How often the import queue is checked while the app is on screen. */
const QUEUE_TICK = 5_000;

/** How often the time unused is checked while the app is on screen. */
const LOCK_TICK = 15_000;

/**
 * Holds the local database and the API client, and keeps things moving while the app is open: the
 * sync the user asks for, the import queue, the theme. The app never goes online on its own, at
 * launch, back in the foreground or on a timer: only for what the user is doing in it (a refresh,
 * adding or looking up a channel, a restored backup), with nothing that identifies the device
 * (D12). A sync the user started goes on off screen, or resumes once the app is back.
 */
export function AppDataProvider({ children }: { children: ReactNode }) {
  const [db] = useState(() => new SubifyDb());
  const [presentAlert] = useIonAlert();
  const ask = useRef<AskConnection>(async () => null);
  // One gate per launch of the app: “Until the app closes” lasts as long as it does.
  const [gate] = useState(() => new ConnectionGate(db, (country) => ask.current(country)));
  const [api] = useState(() => new Api(undefined, gate.guard, () => void updateApp()));

  ask.current = (country) =>
    new Promise<ConnectionTrust | null>((resolve) => {
      void presentAlert({
        header: 'Go online?',
        // The country stands out under the title, behind its flag, so it can be checked at a glance;
        // a warning sign takes its place when the server can’t tell.
        subHeader: country === null ? '⚠️ Unknown country' : [countryFlag(country), countryName(country)].filter(Boolean).join(' '),
        cssClass: 'connection-alert',
        message:
          country === null
            ? 'The server can’t tell where your connection comes from. Check your VPN before continuing.'
            : 'That’s where the server sees your connection coming from. Check that this matches your VPN before continuing.',
        inputs: CONNECTION_TRUSTS.map(({ value, label }) => ({ type: 'radio' as const, label, value, checked: value === 'once' })),
        buttons: [
          { text: 'Cancel', role: 'cancel' },
          { text: 'Continue', role: 'confirm' },
        ],
        onDidDismiss: (event) => resolve(event.detail.role === 'confirm' ? ((event.detail.data as { values?: ConnectionTrust } | undefined)?.values ?? 'once') : null),
      });
    });
  const theme = useLiveQuery(() => loadTheme(db), [db]);
  const running = useRef<Promise<void> | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncDone, setSyncDone] = useState(0);
  // Resumes a sync from a toast: the toast outlives the render that showed it.
  const resumeSync = useRef(() => {});
  const [syncError, setSyncError] = useState<string | null>(null);
  const [presentToast] = useIonToast();
  // Asks to load the newer version of the app, which `updateApp` does.
  const offerUpdate = useCallback(
    (message: string, button: string) =>
      void presentToast({
        message,
        ...toastPlacement(),
        buttons: [
          { text: button, handler: () => void updateApp() },
          { icon: close, role: 'cancel', htmlAttributes: { 'aria-label': 'Close' } },
        ],
      }),
    [presentToast],
  );
  // A refresh that stopped: the next one picks up where it did.
  const offerResume = useCallback(
    (message: string) =>
      void presentToast({
        message,
        ...toastPlacement(),
        buttons: [
          { text: 'Resume', handler: () => resumeSync.current() },
          { icon: close, role: 'cancel', htmlAttributes: { 'aria-label': 'Close' } },
        ],
      }),
    [presentToast],
  );
  const [secretsShown, setSecretsShown] = useState(false);
  const [secretOpened, setSecretOpened] = useState<string | null>(null);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [storageKept, setStorageKept] = useState<boolean>();
  const [vault, setVault] = useState<VaultState>('starting');

  useEffect(() => {
    void startVault(db).then(setVault);
  }, [db]);

  // The screens that read the database leave first (VaultGate), then the key goes.
  useEffect(() => {
    if (vault === 'locked') {
      lockVault(db);
      setSecretsShown(false);
      setSecretOpened(null);
    }
  }, [db, vault]);

  // Locks again as the user chose: back in the foreground, or after some minutes unused (in the
  // background or on screen without a touch). “Each time the app opens” and “never” need nothing here.
  useEffect(() => {
    if (vault !== 'open') {
      return;
    }

    let lastUsed = Date.now();
    const used = () => {
      lastUsed = Date.now();
    };
    const check = async (back: boolean) => {
      const lockAfter = (await readKeyring(db))?.lockAfter;

      if (lockAfter === 'foreground' ? back : typeof lockAfter === 'number' && Date.now() - lastUsed >= lockAfter * 60_000) {
        setVault('locked');
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        used();
      } else {
        void check(true).finally(used);
      }
    };
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void check(false);
      }
    }, LOCK_TICK);

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pointerdown', used, { capture: true, passive: true });
    window.addEventListener('keydown', used, { capture: true, passive: true });

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pointerdown', used, { capture: true });
      window.removeEventListener('keydown', used, { capture: true });
    };
  }, [db, vault]);

  const sync = useCallback((continuing = false) => {
    running.current ??= new Promise<void>((resolve) => {
      // The refresh is over once the feed is: the list of channel names that follows doesn't hold it.
      const settle = (error: unknown) => {
        if (error === null) {
          setSyncError(null);
        } else if (isCancelled(error) || error instanceof LockedError) {
          // Nothing to show: the user stopped it, or the app locked.
        } else if ((error instanceof ServerError && error.code === 'outdated') || appReplaced()) {
          // The old version failing against a newer server: loading the new one is the fix.
          setSyncError(null);
          offerUpdate('This version of the app is out of date.', 'Update');
        } else {
          const message = error instanceof ServerError ? error.message : 'Couldn’t update the feed.';
          setSyncError(message);
          // Said on every page, not only in the feed's subtitle: the user may be elsewhere.
          offerResume(message);
        }

        running.current = null;
        setSyncing(false);
        setSyncDone(0);
        resolve();
      };

      // Inside the approved step, so a sync resumed back on screen does not ask again. The
      // refresh shows as running only from there: while the connection check waits for the
      // user, nothing is on its way.
      const step = async () => {
        setSyncing(true);

        try {
          await syncToTheEnd(() => syncUpdates(db, api, Date.now(), (share) => setSyncDone(share * 100)), documentVisibility);
          await dropOldThumbnails(db);
        } catch (error) {
          settle(error);

          return;
        }

        settle(null);
        // Then, in the background but still inside the step the user approved, the list of
        // channel names: a newer one when the server has it, checked at most once a day.
        await refreshDictionary(db, api);
      };

      (continuing ? gate.within(step) : gate.run(api, step)).catch(settle);
    });

    return running.current;
  }, [db, api, gate, offerUpdate, offerResume]);

  resumeSync.current = () => void sync();

  // A sync cut short when the app closed doesn't go on by itself at the next launch (D12): the
  // user is asked, once the app is open.
  const askedToResume = useRef(false);

  useEffect(() => {
    if (vault !== 'open' || askedToResume.current) {
      return;
    }

    askedToResume.current = true;
    void unfinishedSync(db).then((unfinished) => unfinished && offerResume('Your last refresh didn’t finish.'));
  }, [db, vault, offerResume]);

  // A newer version installed at launch still runs the old code until the page reloads: the user
  // chooses when, rather than losing what they were doing.
  useEffect(() => onAppReplaced(() => offerUpdate('A new version of the app is ready.', 'Reload')), [offerUpdate]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        setSecretsShown(false);
        setSecretOpened(null);
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // The import queue only moves while the app is on screen, one channel at a time: a tick that
  // comes while a submission is still on its way waits for the next one. With the connection
  // check on, it moves only while an approval is remembered: it never opens the dialog itself.
  useEffect(() => {
    if (vault !== 'open') {
      return;
    }

    let busy = false;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !busy) {
        busy = true;
        void gate
          .whenApproved(async () => {
            await runImportQueue(db, api);
          })
          .catch(() => {})
          .finally(() => {
            busy = false;
          });
      }
    }, QUEUE_TICK);

    return () => clearInterval(timer);
  }, [db, api, gate, vault]);

  useEffect(() => {
    if (theme !== undefined) {
      return applyTheme(theme);
    }
  }, [theme]);

  // Asks the browser not to evict the database under storage pressure: it holds the subscriptions.
  // Without its promise, the app warns that the channels may go (StorageWarning).
  useEffect(() => {
    void (navigator.storage?.persist?.() ?? Promise.resolve(false)).then(setStorageKept, () => setStorageKept(false));
  }, []);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };

    // The tab the app was installed from stays a tab: the invitation must still go away.
    const onInstalled = () => setInstalled(true);

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = installState({
    standalone: installed || window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
    canPrompt: installEvent !== null,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
  });

  // The browser's dialog opens once per event. Refused, it leaves the guide for this browser.
  const promptInstall = useCallback(async () => {
    const choice = await installEvent?.prompt();
    setInstallEvent(null);

    if (choice?.outcome === 'accepted') {
      setInstalled(true);
    }
  }, [installEvent]);

  return (
    <AppDataContext.Provider value={{ db, vault, vaultOpened: () => setVault('open'), lock: () => forgetKeptKey(db).then(() => setVault('locked')), api, gate, sync, syncing, syncDone, syncError, secretsShown, setSecretsShown, secretOpened, setSecretOpened, install, promptInstall, storageKept }}>
      {children}
    </AppDataContext.Provider>
  );
}

export function useAppData(): AppData {
  const data = useContext(AppDataContext);

  if (data === null) {
    throw new Error('useAppData must be used inside AppDataProvider.');
  }

  return data;
}
