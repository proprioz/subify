import { IonCheckbox, IonChip, IonIcon, IonItem, IonLabel } from '@ionic/react';
import { close, funnelOutline, optionsOutline, people, searchOutline, swapVerticalOutline } from 'ionicons/icons';
import { type ReactNode, useRef, useState } from 'react';
import { ALL_TYPES, type ShownType, type Subscription } from '../data/db';
import type { ChannelSort, TypeFilter } from '../data/feed';
import { ChannelAvatar } from './ChannelAvatar';
import { Menu } from './Menu';
import { SortMenu } from './SortMenu';

const TYPE_LABELS: Record<ShownType, string> = { video: 'Videos', short: 'Shorts', live: 'Lives' };

interface Props {
  channels: readonly Subscription[];
  selected: string | null;
  onSelect(key: string | null): void;
  /** A double tap on “All” shows or hides the secret channels. */
  onToggleSecrets(): void;
  /** Whether the feed's tools are open. Closing them also closes the search. */
  optionsOpen: boolean;
  onOptionsOpen(open: boolean): void;
  searching: boolean;
  onToggleSearch(): void;
  typeFilter: TypeFilter;
  onToggleType(type: ShownType): void;
  showUpcoming: boolean;
  onToggleUpcoming(): void;
  /** Whether the feed shows other kinds than the default ones: the closed tools then show as on. */
  narrowed: boolean;
  sort: ChannelSort;
  onSort(sort: ChannelSort): void;
}

/**
 * The strip above the feed: the feed's tools folded into “Options” (search, the
 * kinds shown, the channel order), then “All” and every channel, to show only one. Filled chips
 * are the ones in use. Channels show as their avatar alone, so more of them fit; the one shown
 * also gives its name.
 */
export function ChannelStrip(props: Props) {
  const {
    channels,
    selected,
    onSelect,
    onToggleSecrets,
    optionsOpen,
    onOptionsOpen,
    searching,
    onToggleSearch,
    typeFilter,
    onToggleType,
    showUpcoming,
    onToggleUpcoming,
    narrowed,
    sort,
    onSort,
  } = props;
  const [kindsFrom, setKindsFrom] = useState<Event | null>(null);
  const [sortFrom, setSortFrom] = useState<Event | null>(null);
  const lastAllTap = useRef(0);
  const kindsOn = ALL_TYPES.filter((type) => typeFilter[type]).length;

  const tapAll = () => {
    const now = Date.now();

    if (now - lastAllTap.current < 350) {
      lastAllTap.current = 0;
      onToggleSecrets();
    } else {
      lastAllTap.current = now;
      onSelect(null);
    }
  };

  return (
    <>
      <div className="channel-strip ion-padding-horizontal" role="group" aria-label="Filter by channel">
        {optionsOpen ? (
          <>
            <StripChip on={false} onClick={() => onOptionsOpen(false)} label="Close" ariaLabel="Close options" start={<IonIcon icon={close} />} />
            <StripChip on={searching} onClick={onToggleSearch} label="Search" start={<IonIcon icon={searchOutline} />} />
            <StripChip on={narrowed} onClick={setKindsFrom} label="Show" ariaLabel="Show in feed" start={<IonIcon icon={funnelOutline} />} />
            {channels.length > 1 && <StripChip on={false} onClick={setSortFrom} label="Sort" ariaLabel="Sort channels" start={<IonIcon icon={swapVerticalOutline} />} />}
          </>
        ) : (
          <StripChip
            on={narrowed}
            onClick={() => onOptionsOpen(true)}
            label="Options"
            ariaLabel={narrowed ? 'Feed options, filters on' : 'Feed options'}
            start={<IonIcon icon={optionsOutline} />}
          />
        )}

        {channels.length > 1 && <StripChip on={selected === null} onClick={tapAll} label="All" start={<IonIcon icon={people} />} />}
        {channels.length > 1 &&
          channels.map((channel) => (
            <StripChip
              key={channel.key}
              on={selected === channel.key}
              onClick={() => onSelect(selected === channel.key ? null : channel.key)}
              label={channel.title}
              hideLabel={selected !== channel.key}
              start={<ChannelAvatar title={channel.title} avatar={channel.avatar} secret={channel.secret} />}
              secret={channel.secret}
            />
          ))}
      </div>

      <Menu from={kindsFrom} onClose={() => setKindsFrom(null)} heading="Show in feed">
        {ALL_TYPES.map((type, i) => (
          // A line sets the kinds apart from “Upcoming”, which is not one: it applies to all of them.
          <IonItem key={type} {...(i === ALL_TYPES.length - 1 ? { lines: 'full' as const } : {})}>
            <IonCheckbox checked={typeFilter[type]} disabled={typeFilter[type] && kindsOn === 1} onIonChange={() => onToggleType(type)}>
              {TYPE_LABELS[type]}
            </IonCheckbox>
          </IonItem>
        ))}
        <IonItem>
          <IonCheckbox checked={showUpcoming} onIonChange={onToggleUpcoming}>
            Upcoming
          </IonCheckbox>
        </IonItem>
      </Menu>

      <SortMenu from={sortFrom} onClose={() => setSortFrom(null)} sort={sort} onSort={onSort} />
    </>
  );
}

interface StripChipProps {
  /** The channel shown, or a tool in use: drawn filled. */
  on: boolean;
  onClick(event: Event): void;
  label: string;
  ariaLabel?: string;
  /** An avatar or an icon before the label. */
  start: ReactNode;
  /** Shows only `start`; the label is then the chip's accessible name. */
  hideLabel?: boolean;
  secret?: boolean;
}

function StripChip({ on, onClick, label, ariaLabel, start, hideLabel = false, secret = false }: StripChipProps) {
  // The avatar's badge is hidden from screen readers: the name says it instead.
  const name = ariaLabel ?? (hideLabel || secret ? `${label}${secret ? ', secret' : ''}` : undefined);

  return (
    <IonChip
      outline={!on}
      color={on ? 'primary' : 'medium'}
      role="button"
      aria-pressed={on}
      {...(name === undefined ? {} : { 'aria-label': name })}
      onClick={(event) => onClick(event.nativeEvent)}
    >
      {start}
      {!hideLabel && <IonLabel>{label}</IonLabel>}
    </IonChip>
  );
}
