import { IonItem, IonRadio, IonRadioGroup } from '@ionic/react';
import type { ChannelSort } from '../data/feed';
import { Menu } from './Menu';

const SORTS: [ChannelSort, string][] = [
  ['recent', 'Recently added'],
  ['oldest', 'Oldest first'],
  ['name', 'Name, A to Z'],
  ['name-desc', 'Name, Z to A'],
];

interface Props {
  from: Event | null;
  onClose(): void;
  sort: ChannelSort;
  onSort(sort: ChannelSort): void;
}

/** The channel order, shared by the feed's strip and the channel list. */
export function SortMenu({ from, onClose, sort, onSort }: Props) {
  return (
    <Menu from={from} onClose={onClose} heading="Sort channels">
      <IonRadioGroup
        value={sort}
        onIonChange={(event) => {
          onSort(event.detail.value as ChannelSort);
          onClose();
        }}
      >
        {SORTS.map(([value, label]) => (
          <IonItem key={value}>
            <IonRadio value={value}>{label}</IonRadio>
          </IonItem>
        ))}
      </IonRadioGroup>
    </Menu>
  );
}
