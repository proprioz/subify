import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList, IonModal, IonNote, IonSpinner, IonTextarea, IonTitle, IonToolbar } from '@ionic/react';
import { solveChallenge } from '@subify/shared/proof';
import { checkmarkCircle } from 'ionicons/icons';
import { useEffect, useRef, useState } from 'react';
import { useAppData } from '../app/AppData';
import { Api, ServerError } from '../data/api';
import { isCancelled } from '../data/connection-check';

/** Before the app is unlocked its settings can't be read, the connection check's among them: the form asks the server directly. */
const directApi = new Api();

type State =
  | { status: 'asking' }
  | { status: 'off' }
  | { status: 'checking' }
  | { status: 'ready'; proof: string }
  | { status: 'sending'; proof: string }
  | { status: 'sent' }
  | { status: 'failed'; message: string };

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** The app is unlocked: requests go through the connection check, like every other. */
  unlocked: boolean;
}

/**
 * A message to whoever runs this server, which the server sends them by email: their address is
 * never shown. Opening the form asks the server whether it takes messages, and starts the robot
 * check, a second or two of work for the device (packages/shared, proof.ts).
 */
export function ContactModal({ isOpen, onClose, unlocked }: Props) {
  const { api, gate } = useAppData();
  const [state, setState] = useState<State>({ status: 'asking' });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const trap = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  const run = <T,>(step: (server: Api) => Promise<T>): Promise<T> => (unlocked ? gate.run(api, () => step(api)) : step(directApi));

  const start = async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ status: 'asking' });
    setError(null);

    try {
      const challenge = await run((server) => server.contactChallenge());

      if (challenge === null) {
        setState({ status: 'off' });

        return;
      }

      setState({ status: 'checking' });
      const proof = await solveChallenge(challenge, controller.signal);
      setState(proof === null ? { status: 'failed', message: 'The robot check failed. Close the form and try again.' } : { status: 'ready', proof });
    } catch (failure) {
      if (controller.signal.aborted) {
        return;
      }

      if (isCancelled(failure)) {
        onClose();

        return;
      }

      setState({ status: 'failed', message: failure instanceof ServerError ? failure.message : 'Couldn’t reach the server.' });
    }
  };

  useEffect(() => {
    if (isOpen) {
      void start();
    }

    return () => abort.current?.abort();
    // Starts again each time the form opens.
  }, [isOpen]);

  const valid = name.trim() !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && text.trim().length >= 10;

  const send = async () => {
    if (state.status !== 'ready' || !valid) {
      return;
    }

    setState({ status: 'sending', proof: state.proof });
    setError(null);

    try {
      await run((server) =>
        server.sendMessage({ name: name.trim(), email: email.trim(), text: text.trim(), website: trap.current?.value ?? '', proof: state.proof }),
      );
      setState({ status: 'sent' });
      setText('');
    } catch (failure) {
      if (failure instanceof ServerError && failure.status === 400) {
        // An expired check: a new one, and the message stays as it was.
        setError(failure.message);
        void start();

        return;
      }

      setState({ status: 'ready', proof: state.proof });
      setError(isCancelled(failure) ? null : failure instanceof ServerError ? failure.message : 'The message couldn’t be sent.');
    }
  };

  const form = state.status === 'checking' || state.status === 'ready' || state.status === 'sending';

  return (
    <IonModal isOpen={isOpen} onDidDismiss={onClose}>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonButton onClick={onClose}>{state.status === 'sent' ? 'Close' : 'Cancel'}</IonButton>
          </IonButtons>
          <IonTitle>Contact</IonTitle>
          {form && (
            <IonButtons slot="end">
              <IonButton strong disabled={state.status !== 'ready' || !valid} onClick={() => void send()}>
                {state.status === 'sending' ? <IonSpinner name="dots" aria-label="Sending…" /> : 'Send'}
              </IonButton>
            </IonButtons>
          )}
        </IonToolbar>
      </IonHeader>
      <IonContent>
        {state.status === 'asking' && (
          <div className="ion-padding ion-text-center">
            <IonSpinner aria-label="Asking the server…" />
          </div>
        )}
        {state.status === 'off' && <p className="ion-padding">This server doesn’t take messages.</p>}
        {state.status === 'failed' && (
          <IonNote color="danger" role="alert" className="ion-display-block ion-padding">
            {state.message}
          </IonNote>
        )}
        {state.status === 'sent' && <p className="ion-padding">Your message was sent. Thank you!</p>}
        {form && (
          <>
            <IonNote color="medium" className="ion-display-block ion-padding">
              Write to whoever runs this server. Your name, your address and your message reach them by email; the server keeps none of it.
            </IonNote>
            <IonList inset>
              <IonItem>
                <IonInput label="Name" labelPlacement="stacked" autocomplete="name" maxlength={80} value={name} onIonInput={(event) => setName(String(event.detail.value ?? ''))} />
              </IonItem>
              <IonItem>
                <IonInput
                  label="Your email"
                  labelPlacement="stacked"
                  type="email"
                  inputmode="email"
                  autocomplete="email"
                  maxlength={254}
                  helperText="Where the answer goes."
                  value={email}
                  onIonInput={(event) => setEmail(String(event.detail.value ?? ''))}
                />
              </IonItem>
              <IonItem lines="none">
                <IonTextarea
                  label="Message"
                  labelPlacement="stacked"
                  autoGrow
                  rows={5}
                  counter
                  maxlength={2000}
                  value={text}
                  onIonInput={(event) => setText(String(event.detail.value ?? ''))}
                />
              </IonItem>
            </IonList>
            {/* Left empty by people: robots fill in every field. Out of sight, of the keyboard and of screen readers. */}
            <div className="contact-trap" aria-hidden="true">
              <input ref={trap} name="website" type="text" tabIndex={-1} autoComplete="off" />
            </div>
            <IonList inset>
              <IonItem lines="none">
                {state.status === 'checking' ? <IonSpinner slot="start" name="crescent" /> : <IonIcon slot="start" icon={checkmarkCircle} color="success" aria-hidden="true" />}
                <IonLabel>{state.status === 'checking' ? 'Checking you’re not a robot…' : 'Not a robot'}</IonLabel>
              </IonItem>
            </IonList>
            <IonNote color="medium" className="ion-display-block ion-padding-horizontal">
              The check is a little work for your device, without any service of others.
            </IonNote>
            {error !== null && (
              <IonNote color="danger" role="alert" className="ion-display-block ion-padding">
                {error}
              </IonNote>
            )}
          </>
        )}
      </IonContent>
    </IonModal>
  );
}
