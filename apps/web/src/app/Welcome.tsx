import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonLabel, IonList, IonPage, IonText, IonToolbar } from '@ionic/react';
import { personRemoveOutline, playCircleOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import { useRef, useState } from 'react';
import { ContactModal } from '../components/ContactModal';
import { Column } from '../components/Page';
import { AddShot, BackupShot, ChooseShot, RefreshShot } from './TourShots';

const BENEFITS = [
  { icon: playCircleOutline, title: 'Only what you chose', text: 'The latest videos of your channels, in order. No recommendations, no trending page.' },
  { icon: personRemoveOutline, title: 'No account, no tracking', text: 'No sign-up, no ads. Your list stays on your device.' },
  { icon: shieldCheckmarkOutline, title: 'Private by design', text: 'Only you know which channels are yours.' },
];

const TOUR = [
  { shot: <AddShot />, heading: 'Add your channels', text: 'In the Channels tab, paste a channel’s link or @handle, or type its name.' },
  { shot: <RefreshShot />, heading: 'Refresh when you want', text: 'Subify never goes online on its own: pull the feed down or tap refresh to get your new videos.' },
  { shot: <ChooseShot />, heading: 'Make it yours', text: 'For each channel, choose its videos, Shorts or lives. Keep some channels secret: they stay hidden until you unlock them.' },
  { shot: <BackupShot />, heading: 'Keep a backup', text: 'Your channels live only on this device. Save a backup in Settings now and then.' },
];

/**
 * What a first visit shows: what Subify is, then a short tour the user can
 * skip. `onDone` gets whether they came to restore a backup.
 */
export function Welcome({ onDone }: { onDone: (restore: boolean) => void }) {
  const [touring, setTouring] = useState(false);
  const [contacting, setContacting] = useState(false);

  if (!touring) {
    return (
      <IonPage>
        <IonContent className="headerless">
          <div slot="fixed" className="status-backdrop" />
          <Column>
            <div className="welcome ion-padding ion-text-center">
              <img src="/api/icons/pwa-192.png" alt="" width={88} height={88} className="welcome-icon" />
              <h1 className="welcome-name">Subify</h1>
              <h2 className="welcome-headline">Follow creators, not algorithms.</h2>
            </div>
            <IonList inset>
              {BENEFITS.map(({ icon, title, text }, i) => (
                <IonItem key={title} lines={i === BENEFITS.length - 1 ? 'none' : 'full'}>
                  <IonIcon slot="start" icon={icon} aria-hidden="true" />
                  <IonLabel className="ion-text-wrap">
                    <h2>{title}</h2>
                    <p>{text}</p>
                  </IonLabel>
                </IonItem>
              ))}
            </IonList>
            <div className="ion-padding">
              <IonButton expand="block" onClick={() => setTouring(true)}>
                Get started
              </IonButton>
              <IonButton expand="block" fill="clear" color="medium" onClick={() => onDone(true)}>
                I already have a backup
              </IonButton>
            </div>
            <p className="ion-text-center">
              <button type="button" className="quiet-link" onClick={() => setContacting(true)}>
                Contact
              </button>
            </p>
            <ContactModal isOpen={contacting} onClose={() => setContacting(false)} unlocked={false} />
          </Column>
        </IonContent>
      </IonPage>
    );
  }

  return <Tour onDone={() => onDone(false)} finish="Start" />;
}

/**
 * The four steps of the tour, which the user can skip, take again from Settings or the locked
 * screen. The steps sit side by side and snap into place: a swipe and the buttons move the same
 * way, and the step shown follows the scroll.
 */
export function Tour({ onDone, finish }: { onDone: () => void; finish: string }) {
  const [step, setStep] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  const last = step === TOUR.length - 1;

  const go = (to: number) => {
    const element = track.current;
    element?.scrollTo({ left: to * element.clientWidth, behavior: 'smooth' });
  };

  const follow = () => {
    const element = track.current;

    if (element !== null) {
      setStep(Math.min(TOUR.length - 1, Math.max(0, Math.round(element.scrollLeft / element.clientWidth))));
    }
  };

  return (
    <IonPage>
      <IonHeader className="ion-no-border">
        <IonToolbar>
          {step > 0 && (
            <IonButtons slot="start">
              <IonButton onClick={() => go(step - 1)}>Back</IonButton>
            </IonButtons>
          )}
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <Column>
          <div ref={track} className="tour-track" onScroll={follow}>
            {TOUR.map((page, index) => (
              <section key={page.heading} className={index === step ? 'tour-slide tour-slide-on' : 'tour-slide'} aria-hidden={index !== step}>
                {page.shot}
                <h2>{page.heading}</h2>
                <IonText color="medium">
                  <p>{page.text}</p>
                </IonText>
              </section>
            ))}
          </div>
          <div className="ion-padding">
            <div className="tour-dots" role="img" aria-label={`Step ${step + 1} of ${TOUR.length}`}>
              {TOUR.map((page, index) => (
                <span key={page.heading} className={index === step ? 'tour-dot tour-dot-on' : 'tour-dot'} />
              ))}
            </div>
            <IonButton expand="block" onClick={() => (last ? onDone() : go(step + 1))}>
              {last ? finish : 'Next'}
            </IonButton>
            {!last && (
              <IonButton expand="block" fill="clear" color="medium" onClick={() => onDone()}>
                Skip
              </IonButton>
            )}
          </div>
        </Column>
      </IonContent>
    </IonPage>
  );
}
