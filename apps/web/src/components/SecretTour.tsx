import { IonButton } from '@ionic/react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSecretFlow } from '../app/SecretFlow';

/**
 * A bubble of the short tour that follows the first channel made secret (SecretFlow), its arrow
 * pointing up: at the page's ⋯ button (`end`), at a point its container measures (`at`, ChannelStrip),
 * or nowhere.
 */
export function Tip({ arrow, actions, children }: { arrow: 'end' | 'at' | 'none'; actions: ReactNode; children: ReactNode }) {
  return (
    <div className={`tip tip-${arrow}`} role="status">
      <p>{children}</p>
      <div className="tip-actions">{actions}</div>
    </div>
  );
}

/**
 * The tour's steps on a page: in the Channels tab, where secret channels show again; once they are
 * shown, on either page, that a lock can be added. The step on “All” is the feed strip's (`AllTip`).
 */
export function SecretTour({ place }: { place: 'channels' | 'feed' }) {
  const { tour, endTour, lockSecrets } = useSecretFlow();
  const navigate = useNavigate();

  if (tour === 'reveal' && place === 'channels') {
    return (
      <Tip
        arrow="end"
        actions={
          <>
            <IonButton fill="clear" size="small" onClick={() => navigate('/feed')}>
              Next: the feed
            </IonButton>
            <IonButton fill="clear" size="small" className="tip-quiet" onClick={endTour}>
              Close
            </IonButton>
          </>
        }
      >
        Channel hidden. To show your secret channels, tap ⋯ above, then “Show secret channels”.
      </Tip>
    );
  }

  if (tour === 'lock') {
    return (
      <Tip
        arrow="none"
        actions={
          <>
            <IonButton fill="clear" size="small" onClick={() => void lockSecrets(true)}>
              Lock them…
            </IonButton>
            <IonButton fill="clear" size="small" className="tip-quiet" onClick={endTour}>
              Not now
            </IonButton>
          </>
        }
      >
        Here they are. Anyone using the open app can show them too: lock them, now or later from ⋯ in Channels.
      </Tip>
    );
  }

  return null;
}

/** The feed's step, while the tour is at `reveal`: under the strip, pointing at “All”. */
export function AllTip() {
  const { endTour } = useSecretFlow();

  return (
    <Tip
      arrow="at"
      actions={
        <IonButton fill="clear" size="small" className="tip-quiet" onClick={endTour}>
          Close
        </IonButton>
      }
    >
      Double tap “All” to show your secret channels. They hide again when you leave the screen.
    </Tip>
  );
}
