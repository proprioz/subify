import { IonCheckbox, IonChip, IonIcon, IonItem, IonLabel } from '@ionic/react';
import { close, funnelOutline, optionsOutline, people, searchOutline, swapVerticalOutline } from 'ionicons/icons';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ALL_TYPES, type ShownType, type Subscription } from '../data/db';
import type { ChannelSort, TypeFilter } from '../data/feed';
import { ChannelAvatar } from './ChannelAvatar';
import { Menu } from './Menu';
import { SortMenu } from './SortMenu';

const TYPE_LABELS: Record<ShownType, string> = { video: 'Videos', short: 'Shorts', live: 'Lives' };

/** How long the strip takes to glide to the channel shown. */
const GLIDE_MS = 300;

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
  /** A tip under the strip whose arrow points at “All” (SecretTour). */
  hint?: ReactNode;
}

/**
 * The strip above the feed: the feed's tools folded into “Options” (search, the
 * kinds shown, the channel order), then “All” and every channel, to show only one. Filled chips
 * are the ones in use. Channels show as their avatar alone, so more of them fit; the one shown
 * also gives its name, and the strip scrolls to bring it to the middle of the screen: the user can
 * still scroll it away.
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
    hint,
  } = props;
  const [kindsFrom, setKindsFrom] = useState<Event | null>(null);
  const [sortFrom, setSortFrom] = useState<Event | null>(null);
  const lastAllTap = useRef(0);
  const strip = useRef<HTMLDivElement>(null);
  const hintBox = useRef<HTMLDivElement>(null);
  const hinted = hint !== undefined && hint !== null;
  const kindsOn = ALL_TYPES.filter((type) => typeFilter[type]).length;

  useEffect(() => {
    const element = strip.current;

    if (!element) {
      return;
    }

    // Channels' chips are the only ones with an avatar, in the order of `channels`.
    const index = channels.findIndex((channel) => channel.key === selected);
    const chip = element.querySelectorAll(':scope > ion-chip:has(> ion-avatar)')[index];

    if (!chip) {
      return;
    }

    // Where the strip shows the chip in its middle; the last channels go only as far as it scrolls.
    const target = () => {
      const box = element.getBoundingClientRect();
      const { left, width } = chip.getBoundingClientRect();
      const middle = element.scrollLeft + left - box.left + width / 2 - box.width / 2;

      return Math.min(Math.max(0, middle), element.scrollWidth - element.clientWidth);
    };

    // The glide is the app's own rather than the browser's `smooth` scrolling: Safari drops that
    // one when the feed redraws for the channel just after. The target is measured again at each
    // frame, so a chip that changes size meanwhile still ends in the middle.
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;

    const glide = () => {
      const from = element.scrollLeft;
      let start: number | null = null;

      const step = (now: number) => {
        start ??= now;
        const progress = reduced ? 1 : Math.min(1, (now - start) / GLIDE_MS);
        element.scrollLeft = from + (target() - from) * (1 - (1 - progress) ** 3);

        if (progress < 1) {
          frame = requestAnimationFrame(step);
        }
      };

      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(step);
    };

    // Glides once the chip is laid out, and again when it changes size: its name drawn by Ionic a
    // frame later, or the page shown from another tab. The user's own scrolling stops it.
    const observer = new ResizeObserver(glide);
    const stop = () => cancelAnimationFrame(frame);
    observer.observe(chip);
    element.addEventListener('touchstart', stop, { passive: true });
    element.addEventListener('wheel', stop, { passive: true });

    return () => {
      observer.disconnect();
      stop();
      element.removeEventListener('touchstart', stop);
      element.removeEventListener('wheel', stop);
    };
  }, [selected]);

  // The hint's arrow follows “All”, wherever the strip is scrolled and however wide the chips draw.
  useLayoutEffect(() => {
    const box = hintBox.current;
    const all = strip.current?.querySelector('.strip-all');

    if (!box || !all) {
      return;
    }

    const place = () => {
      const { left, width } = all.getBoundingClientRect();
      box.style.setProperty('--tip-at', `${left + width / 2 - box.getBoundingClientRect().left}px`);
    };
    const resized = new ResizeObserver(place);
    resized.observe(all);
    resized.observe(box);
    const scrolled = strip.current;
    scrolled?.addEventListener('scroll', place, { passive: true });
    place();

    return () => {
      resized.disconnect();
      scrolled?.removeEventListener('scroll', place);
    };
  }, [hinted, optionsOpen]);

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
      <div ref={strip} className="channel-strip ion-padding-horizontal" role="group" aria-label="Filter by channel">
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

        {/* “All” shows even beside one channel, or none: otherwise it would come and go with the
            secret channels, which it shows on a double tap, and tell that some are hidden. */}
        <StripChip on={selected === null} onClick={tapAll} label="All" start={<IonIcon icon={people} />} className="strip-all" />
        {channels.length > 1 &&
          channels.map((channel) => (
            <StripChip
              key={channel.key}
              on={selected === channel.key}
              onClick={() => onSelect(selected === channel.key ? null : channel.key)}
              label={channel.title}
              hideLabel={selected !== channel.key}
              start={<ChannelAvatar channel={channel.key} title={channel.title} avatar={channel.avatar} />}
              secret={channel.secret}
              {...(channel.secret ? { className: 'strip-secret' } : {})}
            />
          ))}
      </div>
      {hinted && <div ref={hintBox}>{hint}</div>}

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
  className?: string;
}

function StripChip({ on, onClick, label, ariaLabel, start, hideLabel = false, secret = false, className }: StripChipProps) {
  // A secret channel's chip only shows it by its frost: the name says it to screen readers.
  const name = ariaLabel ?? (hideLabel || secret ? `${label}${secret ? ', secret' : ''}` : undefined);

  return (
    <IonChip
      outline={!on}
      color={on ? 'primary' : 'medium'}
      {...(className === undefined ? {} : { className })}
      role="button"
      // As a string: React gives `true` to a custom element as an empty attribute, which isn't “pressed”.
      aria-pressed={on ? 'true' : 'false'}
      {...(name === undefined ? {} : { 'aria-label': name })}
      onClick={(event) => onClick(event.nativeEvent)}
    >
      {start}
      {!hideLabel && <IonLabel>{label}</IonLabel>}
    </IonChip>
  );
}
