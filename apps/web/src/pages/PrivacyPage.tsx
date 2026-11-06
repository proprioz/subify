import type { InstanceResponse } from '@subify/shared';
import { IonButton, IonNote, IonSpinner } from '@ionic/react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { ContactModal } from '../components/ContactModal';
import { Page } from '../components/Page';
import { ServerError } from '../data/api';
import { isCancelled } from '../data/connection-check';

/** What each party can see, said plainly. Keep it in step with how the app and the server work. */
export function PrivacyPage() {
  return (
    <Page title="Privacy" back="/settings">
      <div className="ion-padding">
        <p>Subify has no accounts. Your list of channels is kept on this device only, and nothing records what you open.</p>

        <h2>On this device</h2>
        <p>
          What is yours stays with you: the channels you follow, their videos, your choices and your settings live on this device. Nothing sends them anywhere to be analysed.
          Your password and your passkey never leave this device.
        </p>
        <ul>
          <li>The app’s data on this device is always encrypted, from the first launch.</li>
          <li>
            Until you lock Subify, the app keeps the key on this device and opens without asking: your phone’s or computer’s own lock guards it. To lock Subify itself, turn
            on a passkey, which lets you use Face ID, a fingerprint or Windows Hello, or set a password, then choose when it asks.
          </li>
          <li>Subify makes one passkey per device, kept by your device’s password manager. It never reaches the server.</li>
          <li>If you lose your password, or delete that key without a password, the app’s data can’t be opened again. A backup lets you start over.</li>
          <li>Hidden channels stay hidden until you unlock them.</li>
        </ul>

        <h2>What the server sees</h2>
        <p>
          The app never goes online on its own, never when it opens or on a timer: only for what you are doing in it, such as adding a channel, refreshing your feed or
          restoring a backup. Its requests carry nothing that identifies your device or ties one request to another. The server then sees a few things, and doesn’t watch
          your habits: nothing it keeps lets anyone trace the channels you follow or what you do in the app.
        </p>
        <ul>
          <li>When you refresh, your device downloads the news of many channels at once and keeps only yours. The server doesn’t learn which ones are yours.</li>
          <li>When you add a channel it doesn’t have yet, the server sees that channel, but not who asked.</li>
          <li>
            Looking a channel up by its name starts on this device, in a public list of channel names, the same for everyone, that the app downloads when you start
            adding a channel or refresh (about 5 MB, again when the server renews it). If nothing is found there, the server searches: on Invidious or Piped, services
            run by others, if this server’s operator turned them on, and last on YouTube. These searches leave from the server, never from your device, so they stay anonymous, and the server forgets
            them.
          </li>
          <li>
            With the connection check on in Settings, the app first asks the server which country it sees you from, for example to make sure your VPN is on. The server doesn’t
            keep the answer.
          </li>
          <li>Everything the server stores about the channels people follow is encrypted.</li>
        </ul>
        <p>
          <Link to="/settings/why">Sealring</Link>, in Why Subify, explains how in a few lines.
        </p>

        <h2>What the server’s operator can see</h2>
        <p>
          The server runs on a hosting platform which, like any host, handles the network traffic, including your IP address, under its own privacy policy. The person or company
          running the server can see what that platform shows them:
        </p>
        <ul>
          <li>How many requests each address sends per second, so that an address sending too many can be blocked for a moment.</li>
          <li>
            A record of requests, kept for a limited time: the address, the time, the browser and the country. These records never show the channels you follow or what the
            server holds: they are inside the requests, whose content isn’t recorded.
          </li>
          <li>Technical records of how the server runs, such as errors and timings. They say nothing about who you are or what you follow.</li>
        </ul>
        <p>
          If you’d rather the host didn’t see your IP address, use a VPN. If you’d rather no one else handles your traffic, host the server yourself: the app only talks to the
          server it was installed from.
        </p>

        <h2>What YouTube sees</h2>
        <p>
          Nothing from this device while you browse the app: the server fetches channels’ public feeds, avatars and thumbnails, without any account, key or identifier of yours,
          and the app shows the copies it keeps. When you open a video, YouTube sees that visit as usual.
        </p>

        <h2>Who runs this server</h2>
        <Operator />

        <h2>Backups</h2>
        <p>A backup is a file locked with the password you choose. It stays where you save it; the app never sends it anywhere and never stores the password.</p>
      </div>
    </Page>
  );
}

type OperatorState = { status: 'idle' } | { status: 'asking' } | { status: 'known'; instance: InstanceResponse } | { status: 'failed'; message: string };

/**
 * The server's name and operator, which the server alone knows: the app is the same for every
 * server. Asked only when the user taps, through the connection check like any request.
 */
function Operator() {
  const { api, gate } = useAppData();
  const [state, setState] = useState<OperatorState>({ status: 'idle' });
  const [contacting, setContacting] = useState(false);

  const ask = async () => {
    setState({ status: 'asking' });

    try {
      setState({ status: 'known', instance: await gate.run(api, () => api.instance()) });
    } catch (failure) {
      setState(isCancelled(failure) ? { status: 'idle' } : { status: 'failed', message: failure instanceof ServerError ? failure.message : 'Couldn’t ask the server.' });
    }
  };

  if (state.status === 'known') {
    const { name, operator, messages } = state.instance;

    return (
      <>
        {operator === null ? (
          <p>This server, “{name}”, doesn’t say who runs it.</p>
        ) : (
          <p>
            This server, “{name}”, is run by {operator.name ?? 'its operator'}.
            {operator.contact !== null && <> For any question about your data, write to {operator.contact}.</>}
          </p>
        )}
        {messages && (
          <>
            <p>
              If you write to them through the{' '}
              <button type="button" className="text-link" onClick={() => setContacting(true)}>
                contact form
              </button>
              , your name, your address and your message reach them by email; the server keeps none of it.
            </p>
            <ContactModal isOpen={contacting} onClose={() => setContacting(false)} unlocked />
          </>
        )}
      </>
    );
  }

  return (
    <>
      <p>The app is the same on every server: only the server can say who runs it.</p>
      {state.status === 'failed' && <IonNote color="danger" role="alert" className="ion-display-block ion-padding-bottom">{state.message}</IonNote>}
      <IonButton size="small" disabled={state.status === 'asking'} onClick={() => void ask()}>
        {state.status === 'asking' ? <IonSpinner name="dots" aria-label="Asking…" /> : 'Show who runs this server'}
      </IonButton>
    </>
  );
}
