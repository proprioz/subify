import { IonList, IonListHeader, IonNote } from '@ionic/react';
import type { ReactNode } from 'react';

interface Props {
  heading?: string;
  /** A line of help under the group, where both platforms put it. */
  footer?: string;
  children: ReactNode;
}

/** A group of rows, as in the system settings of iOS and Android: a heading, the rows, a note. */
export function Section({ heading, footer, children }: Props) {
  return (
    <section>
      {heading !== undefined && <IonListHeader>{heading}</IonListHeader>}
      <IonList inset>{children}</IonList>
      {footer !== undefined && (
        <IonNote color="medium" className="ion-display-block ion-padding-horizontal ion-padding-bottom">
          {footer}
        </IonNote>
      )}
    </section>
  );
}
