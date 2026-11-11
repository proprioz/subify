import { IonButton, IonContent, IonIcon, IonPopover } from '@ionic/react';
import { informationCircleOutline } from 'ionicons/icons';
import { type ReactNode, useState } from 'react';
import { retryLabel } from '../data/format';

/**
 * An ⓘ beside a short line, opening a tooltip that explains it. Taps on either stay theirs: the
 * row it sits in doesn't open.
 */
export function InfoButton({ label, children }: { label: string; children: ReactNode }) {
  const [from, setFrom] = useState<Event | null>(null);

  return (
    <>
      <IonButton
        fill="clear"
        size="small"
        color="medium"
        className="info-button"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          setFrom(event.nativeEvent);
        }}
      >
        <IonIcon slot="icon-only" icon={informationCircleOutline} />
      </IonButton>
      <IonPopover className="info-popover" isOpen={from !== null} event={from ?? undefined} onDidDismiss={() => setFrom(null)} onClick={(event) => event.stopPropagation()}>
        <IonContent className="ion-padding">{children}</IonContent>
      </IonPopover>
    </>
  );
}

/** Why a channel shows no videos: the server keeps none older than six months (RETENTION_DAYS), even when it's added. */
export function NotFetchedInfo({ title }: { title: string }) {
  return (
    <InfoButton label={`Why no videos from ${title}`}>
      <p className="ion-no-margin">Only videos from the last six months are fetched. New uploads will show up here.</p>
      <p className="ion-no-margin ion-padding-top">Recent ones may also be of kinds you hide, or not read yet.</p>
    </InfoButton>
  );
}

/** Why a channel just added in clear may bring its next videos late (Subscription.submittedAt). */
export function JoiningInfo({ title }: { title: string }) {
  return (
    <InfoButton label={`Why videos from ${title} may be late`}>
      <p className="ion-no-margin">
        A channel new to this server joins its catalog at a random time within six hours, so that when it joins can’t be tied to you. Until then, this channel’s new
        videos may show up a few hours late.
      </p>
    </InfoButton>
  );
}

/** What to do about a channel the server couldn't read yet (Subscription.retryAt): the solution, first. */
export function refreshHint(retryAt: number, now = Date.now()): string {
  const after = retryLabel(retryAt, now, 'after');

  return after === null ? 'Refresh in a few minutes' : `Refresh ${after}`;
}

/** When the server reads it again, as a sentence. */
export function retrySentence(retryAt: number, now = Date.now()): string {
  const at = retryLabel(retryAt, now);

  return at === null ? 'Another try is under way.' : `Another try comes ${at}.`;
}

/** Why a channel shows no videos when its last read failed. */
export function RetryInfo({ title, retryAt }: { title: string; retryAt: number }) {
  return (
    <InfoButton label={`Why no videos from ${title}`}>
      <p className="ion-no-margin">The last try to fetch this channel’s videos failed. {retrySentence(retryAt)}</p>
    </InfoButton>
  );
}
