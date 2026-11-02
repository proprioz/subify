import { IonButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonList, IonModal, IonNote, IonSpinner, IonTextarea, IonTitle, IonToolbar } from '@ionic/react';
import type { ContactChallengeResponse } from '@subify/shared';
import type { WidgetMethods } from 'altcha/types';
import type {} from 'altcha/types/react';
import { useEffect, useRef, useState } from 'react';
import { useAppData } from '../app/AppData';
import { Api, ServerError } from '../data/api';
import { isCancelled } from '../data/connection-check';

/** Before the app is unlocked its settings can't be read, the connection check's among them: the form asks the server directly. */
const directApi = new Api();

/**
 * ALTCHA's widget (https://altcha.org) with its styles and its hashing worker, loaded the first
 * time the form opens. The `external` build, unlike the main one, puts its worker in a file of
 * its own: the Content-Security-Policy (public/_headers) allows no worker from a blob.
 */
let widgetLoaded: Promise<void> | undefined;

function loadWidget(): Promise<void> {
  widgetLoaded ??= Promise.all([import('altcha/external'), import('altcha/altcha.css'), import('altcha/workers/sha?worker')]).then(
    ([, , { default: ShaWorker }]) => {
      $altcha.algorithms.set('SHA-256', () => new ShaWorker());
      $altcha.i18n.set('en', {
        ...$altcha.i18n.get('en'),
        label: 'I’m not a robot',
        loading: 'Loading…',
        verifying: 'Checking…',
        waitAlert: 'Checking… please wait.',
        error: 'The check failed. Try again.',
        expired: 'The check expired. Try again.',
      });
    },
    (failure: unknown) => {
      widgetLoaded = undefined;
      throw failure;
    },
  );

  return widgetLoaded;
}

type State = { status: 'asking' } | { status: 'off' } | { status: 'form' } | { status: 'sending' } | { status: 'sent' } | { status: 'failed'; message: string };

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** The app is unlocked: requests go through the connection check, like every other. */
  unlocked: boolean;
}

/**
 * A message to whoever runs this server, which the server sends them by email: their address is
 * never shown. Opening the form asks the server whether it takes messages; ticking “I’m not a
 * robot” solves the robot check, a second or two of work for the device (packages/shared, proof.ts).
 */
export function ContactModal({ isOpen, onClose, unlocked }: Props) {
  const { api, gate } = useAppData();
  const [state, setState] = useState<State>({ status: 'asking' });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** The solved robot check, once the box is ticked. */
  const [proof, setProof] = useState<string | null>(null);
  const trap = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const widget = useRef<HTMLElement & WidgetMethods>(null);
  /** The robot check asked for when the form opened, for the first tick of the box. */
  const opening = useRef<ContactChallengeResponse | null>(null);

  const run = <T,>(step: (server: Api) => Promise<T>): Promise<T> => (unlocked ? gate.run(api, () => step(api)) : step(directApi));

  const start = async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ status: 'asking' });
    setError(null);
    setProof(null);

    try {
      const [, challenge] = await Promise.all([loadWidget(), run((server) => server.contactChallenge())]);

      if (controller.signal.aborted) {
        return;
      }

      opening.current = challenge;
      setState(challenge === null ? { status: 'off' } : { status: 'form' });
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

  const form = state.status === 'form' || state.status === 'sending';

  useEffect(() => {
    const element = widget.current;

    if (!form || element === null) {
      return;
    }

    void element.configure({
      // The widget asks for a robot check when the box is ticked. The first is the one the form
      // got when it opened; the next ones, after one expired or the server refused it, go
      // through the API like every request, the connection check included.
      challenge: '/api/contact',
      fetch: async () => {
        const challenge = opening.current ?? (await run((server) => server.contactChallenge()).catch(stop));
        opening.current = null;

        if (challenge === null) {
          setState({ status: 'off' });

          throw new Error('This server doesn’t take messages.');
        }

        return Response.json(challenge);
      },
      // Off: it records the pointer's movements and the scrolling, for ALTCHA's Sentinel server, which this one isn't.
      humanInteractionSignature: false,
    });

    const onStateChange = (event: Event) => {
      const { state: checkState, payload } = (event as CustomEvent<{ state: string; payload?: string }>).detail;
      setProof(checkState === 'verified' && payload !== undefined ? payload : null);
    };

    element.addEventListener('statechange', onStateChange);

    return () => element.removeEventListener('statechange', onStateChange);
    // Set up once each time the form shows.
  }, [form]);

  /** A connection check the user cancelled closes the form, as when it opens. */
  const stop = (failure: unknown): never => {
    if (isCancelled(failure)) {
      onClose();
    }

    throw failure;
  };

  const valid = name.trim() !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && text.trim().length >= 10;

  const send = async () => {
    if (state.status !== 'form' || proof === null || !valid) {
      return;
    }

    setState({ status: 'sending' });
    setError(null);

    try {
      await run((server) => server.sendMessage({ name: name.trim(), email: email.trim(), text: text.trim(), website: trap.current?.value ?? '', proof }));
      setState({ status: 'sent' });
      setProof(null);
      setText('');
    } catch (failure) {
      setState({ status: 'form' });

      if (failure instanceof ServerError && failure.status === 400) {
        // An expired check: the box unticks, ticking it again asks for a new one, and the message stays as it was.
        setProof(null);
        widget.current?.reset();
        setError('The robot check expired. Tick the box again.');

        return;
      }

      setError(isCancelled(failure) ? null : failure instanceof ServerError ? failure.message : 'The message couldn’t be sent.');
    }
  };

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
              <IonButton strong disabled={state.status !== 'form' || proof === null || !valid} onClick={() => void send()}>
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
                <altcha-widget ref={widget} />
              </IonItem>
            </IonList>
            <IonNote color="medium" className="ion-display-block ion-padding-horizontal">
              Ticking the box gives your device a second or two of work. ALTCHA is open-source code that comes with the app: no other service takes part.
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
