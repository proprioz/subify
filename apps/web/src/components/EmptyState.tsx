import { IonIcon, IonText } from '@ionic/react';
import type { ReactNode } from 'react';

interface Props {
  icon: string;
  heading: string;
  children: ReactNode;
  actions?: ReactNode;
}

/**
 * What a page shows when it has nothing to list yet, with what to do next: an icon, a line and a
 * button, straight on the page, as empty screens are drawn on both platforms.
 */
export function EmptyState({ icon, heading, children, actions }: Props) {
  return (
    <div className="empty-state ion-padding ion-text-center">
      <IonIcon icon={icon} color="medium" aria-hidden="true" />
      <h2>{heading}</h2>
      <IonText color="medium">
        <p>{children}</p>
      </IonText>
      {actions !== undefined && <div className="ion-padding-top">{actions}</div>}
    </div>
  );
}
