import { IonIcon, IonItem, IonLabel, IonList, IonListHeader, IonPopover } from '@ionic/react';
import type { ReactNode } from 'react';
import type { PlatformIcon } from '../ui/icons';

export interface MenuAction {
  text: string;
  icon: string | PlatformIcon;
  handler(): void;
  /** Drawn in red: removals. */
  danger?: boolean;
}

interface Props {
  /** The click that opened it, which places it; null while closed. */
  from: Event | null;
  onClose(): void;
  heading?: string;
  actions?: readonly MenuAction[];
  /** Other content, such as checkboxes or radios, instead of actions. */
  children?: ReactNode;
}

/** A menu that drops down from its button. It closes once an action is picked. */
export function Menu({ from, onClose, heading, actions = [], children }: Props) {
  return (
    <IonPopover isOpen={from !== null} event={from ?? undefined} onDidDismiss={onClose} dismissOnSelect={children === undefined}>
      <IonList lines="none">
        {heading !== undefined && <IonListHeader>{heading}</IonListHeader>}
        {actions.map((action) => {
          const color = action.danger === true ? { color: 'danger' } : {};
          const icon = typeof action.icon === 'string' ? { icon: action.icon } : action.icon;

          return (
            <IonItem key={action.text} button detail={false} onClick={action.handler}>
              <IonIcon slot="start" {...icon} {...color} aria-hidden="true" />
              <IonLabel {...color}>{action.text}</IonLabel>
            </IonItem>
          );
        })}
        {children}
      </IonList>
    </IonPopover>
  );
}
