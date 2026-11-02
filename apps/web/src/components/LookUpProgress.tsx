import { IonButton, IonIcon, IonItem, IonLabel, IonList, IonNote, IonSpinner } from '@ionic/react';
import { alertCircle, checkmarkCircle, chevronDown, chevronUp } from 'ionicons/icons';
import { useEffect, useState } from 'react';
import type { LookUpStep } from '../data/subscriptions';

/** One line of a lookup's log: a step, from when it started. Steps of the same kind share a line. */
export interface LogEntry {
  step: LookUpStep;
  at: number;
}

/** The server answers `POST /add` after at least this long, found or not (apps/server/src/catalog/add.ts). */
const ADD_LATENCY = 8_000;

/**
 * What the step does, in plain words, for the view without details: where the search is, named
 * the way a user knows these places, never by host or protocol.
 */
function summary(step: LookUpStep): string {
  switch (step.kind) {
    case 'dictionary':
    case 'download':
      return 'Getting the list of channel names';
    case 'local':
      return 'Searching on your device';
    case 'catalog':
    case 'blind':
    case 'handles':
    case 'group':
      return 'Looking in Subify’s catalog';
    case 'search':
      return 'Asking independent search engines';
    case 'add':
      return 'Asking YouTube';
  }
}

/** The detailed log's line for a step: exactly what is sent where. */
function label(step: LookUpStep): string {
  switch (step.kind) {
    case 'dictionary':
      return 'Checking the dictionary of channel names';
    case 'download':
      return `Downloading the dictionary of names, once: part ${step.slice} of ${step.slices}`;
    case 'local':
      return 'Searching the dictionary on this device';
    case 'catalog':
      return 'Reading the catalog’s public key';
    case 'blind':
      return step.inputs === 1 ? 'Sealing the channel and asking the catalog blindly' : `Sealing ${step.inputs} likely @handles and asking the catalog blindly`;
    case 'handles':
      return step.chunks === 1 ? 'Reading the handle index' : `Reading the whole handle index: part ${step.chunk} of ${step.chunks}`;
    case 'group':
      return 'Downloading the channel’s whole group and opening its entry';
    case 'search':
      return `Request sent to ${location.host}, to search Invidious and Piped if it uses them`;
    case 'add':
      return `Request sent to ${location.host}, which reads the channel online`;
  }
}

/**
 * How long the current step should still take, when it can be told: the list of names from the
 * speed of its parts so far, YouTube from the server's fixed minimum.
 */
function estimate(entry: LogEntry, now: number): string {
  const elapsed = now - entry.at;
  const { step } = entry;

  if (step.kind === 'download' && step.slice > 1) {
    const done = step.slice - 1;

    return `Once only · about ${seconds(((step.slices - done) * elapsed) / done)} left`;
  }

  if (step.kind === 'add') {
    return elapsed < ADD_LATENCY ? `About ${seconds(ADD_LATENCY - elapsed)} left` : 'Taking a little longer…';
  }

  if (step.kind === 'search') {
    return 'Usually a few seconds';
  }

  return 'A few steps, so your search stays private';
}

function seconds(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 1000))} s`;
}

function duration(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Re-renders every quarter second while `on`, for the times and estimates. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!on) {
      return;
    }

    const timer = setInterval(() => setNow(Date.now()), 250);

    return () => clearInterval(timer);
  }, [on]);

  return on ? now : Date.now();
}

/**
 * What a lookup is doing while it runs: a dot going round, the step in plain words, how long it
 * should still take, and the exact log behind “See details”. The dot takes the platform's red
 * while the search is online, as the app's buttons that go online do.
 */
export function LookUpProgress({ log }: { log: LogEntry[] }) {
  const now = useNow(true);
  const current = log.at(-1);
  const online = current?.step.kind === 'search' || current?.step.kind === 'add';

  return (
    <div className={`lookup-progress ion-padding${online ? ' lookup-online' : ''}`}>
      <div className="lookup-orbit" aria-hidden="true">
        <span />
      </div>
      <p className="lookup-step" role="status">
        {current === undefined ? 'Looking up…' : `${summary(current.step)}…`}
      </p>
      <IonNote color="medium" className="ion-display-block lookup-left">
        {current === undefined ? '' : estimate(current, now)}
      </IonNote>
      <LookUpLog log={log} now={now} running />
    </div>
  );
}

/** The exact steps a lookup went through, with their times, behind “See details”. */
export function LookUpLog({ log, now, running = false, failed = false, ended }: { log: LogEntry[]; now?: number; running?: boolean; failed?: boolean; ended?: number }) {
  const [open, setOpen] = useState(false);

  if (log.length === 0) {
    return null;
  }

  const end = ended ?? now ?? Date.now();

  return (
    <div className="lookup-log">
      <IonButton fill="clear" size="small" color="medium" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide details' : 'See details'}
        <IonIcon slot="end" icon={open ? chevronUp : chevronDown} />
      </IonButton>
      {open && (
        <IonList inset lines="none" className="ion-text-start">
          {log.map((entry, index) => {
            const last = index === log.length - 1;
            const until = last ? end : log[index + 1]!.at;

            return (
              <IonItem key={index}>
                {last && running ? (
                  <IonSpinner slot="start" name="crescent" />
                ) : last && failed ? (
                  <IonIcon slot="start" color="danger" icon={alertCircle} />
                ) : (
                  <IonIcon slot="start" color="medium" icon={checkmarkCircle} />
                )}
                <IonLabel className="ion-text-wrap">
                  <p>{label(entry.step)}</p>
                </IonLabel>
                <IonNote slot="end" className="lookup-log-time">
                  {duration(until - entry.at)}
                </IonNote>
              </IonItem>
            );
          })}
        </IonList>
      )}
    </div>
  );
}
