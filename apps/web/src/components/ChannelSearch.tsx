import { IonButton, IonIcon, IonItem, IonLabel, IonNote, IonSpinner } from '@ionic/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { add, checkmark, search } from 'ionicons/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { ServerError } from '../data/api';
import { isChannelInput, isChannelName } from '../data/channel-link';
import { isCancelled } from '../data/connection-check';
import type { Subscription } from '../data/db';
import { ensureDictionary, hasDictionary, type NamedChannel, searchDictionary } from '../data/dictionary';
import { followMany } from '../data/follow-many';
import { AlreadyFollowing, type FoundChannel, findChannel, follow, TooManyChannels } from '../data/subscriptions';
import { useToast } from '../ui/toast';
import { ChannelAvatar } from './ChannelAvatar';
import { Section } from './Section';

/**
 * Adding a channel (docs/FEATURES.md, §2): one list under the Channels tab's field, as a search
 * box's suggestions. It holds the followed channels the text matches, marked “Following”, the
 * channels the Wikidata dictionary names like it, searched on the device while it is typed, each
 * with “Follow”, and last, always, “Search online”, which adds what it finds online
 * to the same list. The user never sees where a search goes: the steps behind it (the catalog
 * blindly, the search services, the guessed handles read online) are the app's business.
 *
 * Nothing goes online while typing: every lookup of a channel the catalog lacks costs the server a
 * read online, and a handle being typed would be read letter by letter. The wider search is the
 * user's action: its row, or Enter.
 */

/** Where a name's wider search goes on from: the dictionary (not on the device yet), the search services, or the server's guessed handles. */
type Step = 'dictionary' | 'search' | 'guess';

interface Wider {
  text: string;
  status: 'searching' | 'done' | 'nothing' | 'failed';
  matches: NamedChannel[];
  found: FoundChannel | null;
  /** The next step a name can go on to, or null when there is none left. */
  next: Step | null;
}

export interface ChannelSearch {
  term: string;
  /** The dictionary's matches, while the text is typed. */
  suggested: NamedChannel[];
  wider: Wider | null;
  /** Whether “Search online” can go further for this text. */
  canWiden: boolean;
  widen(): Promise<void>;
}

/** The suggestions for the field's text, and its wider search. */
export function useChannelSearch(text: string): ChannelSearch {
  const { db, api, gate } = useAppData();
  const term = text.trim();
  const [suggested, setSuggested] = useState<NamedChannel[]>([]);
  const [wider, setWider] = useState<Wider | null>(null);
  // The dictionary may arrive while the name is being typed: the matches then show without another key.
  const ready = useLiveQuery(() => hasDictionary(db), [db]) ?? false;
  // Each new text moves this on, so a late answer never shows under newer text.
  const latest = useRef(0);

  useEffect(() => {
    latest.current += 1;
    setWider(null);
    let current = true;
    const timer = setTimeout(() => {
      void (async () => {
        const words = isChannelName(term) || /^@[\w.-]{3,}$/.test(term) ? term : '';
        const found = words !== '' && ready ? await searchDictionary(db, words, 8) : [];

        if (current) {
          setSuggested(found);
        }
      })();
    }, 150);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [db, term, ready]);

  const searchable = isChannelInput(term) || isChannelName(term);
  const canWiden = searchable && (wider === null || (wider.status !== 'searching' && wider.next !== null));

  const widen = useCallback(async () => {
    if (!canWiden) {
      return;
    }

    const id = latest.current;
    const from: Step = wider?.next ?? (isChannelName(term) && suggested.length === 0 ? 'dictionary' : 'search');
    const previous = { matches: wider?.matches ?? [], found: wider?.found ?? null };
    const show = (next: Wider) => {
      if (id === latest.current) {
        setWider(next);
      }
    };
    show({ text: term, status: 'searching', ...previous, next: from });

    try {
      const answer = await gate.run(api, async (): Promise<Omit<Wider, 'text'>> => {
        // Without the dictionary yet (the connection check kept it from coming with the field), it comes now.
        if (from === 'dictionary' && ((await hasDictionary(db)) || (await ensureDictionary(db, api)))) {
          const matches = await searchDictionary(db, term);

          if (matches.length > 0) {
            return { status: 'done', matches: [...previous.matches, ...matches], found: null, next: 'search' };
          }
        }

        const found = await findChannel(db, api, term, { search: from !== 'guess' });

        return 'matches' in found
          ? { status: 'done', matches: [...previous.matches, ...found.matches], found: previous.found, next: isChannelName(term) ? 'guess' : null }
          : { status: 'done', ...previous, found, next: null };
      });
      show({ text: term, ...answer });
    } catch (failure) {
      // Cancelling the connection check leaves the list as it was.
      if (isCancelled(failure)) {
        show({ text: term, status: 'done', ...previous, next: from });
      } else {
        const nothing = failure instanceof ServerError && (failure.code === 'channel_not_found' || failure.code === 'invalid_link');
        show({ text: term, status: nothing ? 'nothing' : 'failed', ...previous, next: nothing ? null : from });
      }
    }
  }, [db, api, gate, term, wider, suggested, canWiden]);

  return { term, suggested, wider: wider?.text === term ? wider : null, canWiden, widen };
}

type Row = { kind: 'own'; subscription: Subscription } | { kind: 'named'; channel: NamedChannel } | { kind: 'found'; found: FoundChannel };

/**
 * The list under the field: followed channels the text matches first, then the dictionary's
 * suggestions, then what the wider search found, each channel once, and “Search online”.
 */
export function ChannelSearchResults({ finder, own, onOpen }: { finder: ChannelSearch; own: readonly Subscription[]; onOpen(subscription: Subscription): void }) {
  const { db, api, gate, secretsShown } = useAppData();
  const toast = useToast();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [followedHere, setFollowedHere] = useState<ReadonlySet<string>>(new Set());
  const subscriptions = useLiveQuery(() => db.subscriptions.toArray(), [db]) ?? [];
  // A secret channel hidden right now must not show as followed: its row stays out instead.
  const byKey = new Map(subscriptions.map((subscription) => [subscription.key, subscription]));
  const hidden = (key: string) => byKey.get(key)?.secret === true && !secretsShown;
  const { wider } = finder;
  // The last step of a wider search answers after 8 seconds at least (POST /add): past a few
  // seconds, the row says the search is still going rather than leave a spinner alone.
  const searching = wider?.status === 'searching';
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);

    if (!searching) {
      return;
    }
    const timer = setTimeout(() => setSlow(true), 3000);

    return () => clearTimeout(timer);
  }, [searching]);

  const rows: Row[] = [];
  const seen = new Set<string>();
  const push = (key: string, row: Row) => {
    if (!seen.has(key) && !hidden(key)) {
      seen.add(key);
      rows.push(row);
    }
  };
  // Channels already followed come first, with their own avatar, even when the dictionary names
  // them too; one followed from this list keeps its place: following it only turns its button.
  const named = [...finder.suggested, ...(wider?.matches ?? [])];
  own.filter((subscription) => !followedHere.has(subscription.key)).forEach((subscription) => push(subscription.key, { kind: 'own', subscription }));
  named.forEach((channel) => push(`youtube:${channel.id}`, { kind: 'named', channel }));

  if (wider?.found) {
    const key = 'following' in wider.found ? wider.found.following.key : wider.found.submitted.channel.key;
    push(key, { kind: 'found', found: wider.found });
  }

  const withBusy = async (key: string, work: () => Promise<void>) => {
    setBusy((current) => new Set(current).add(key));
    setFollowedHere((current) => new Set(current).add(key));

    try {
      await work();
    } catch (error) {
      if (!isCancelled(error)) {
        await toast(error instanceof TooManyChannels ? error.message : 'Couldn’t follow this channel. Try again.');
      }
    } finally {
      setBusy((current) => new Set([...current].filter((other) => other !== key)));
    }
  };

  // A channel the catalog has is filled at once, blindly; another waits in the import queue,
  // which adds it in the background.
  const followNamed = (channel: NamedChannel) =>
    withBusy(`youtube:${channel.id}`, async () => {
      const { queued } = await gate.run(api, () => followMany(db, api, [{ key: `youtube:${channel.id}`, title: channel.name, handle: channel.handle }]));
      await toast(queued > 0 ? `${channel.name} will be added in a few seconds.` : `Now following ${channel.name}.`);
    });

  // The wider search's answer already holds the channel: following it asks nothing more.
  const followFound = (found: FoundChannel) =>
    'submitted' in found
      ? withBusy(found.submitted.channel.key, async () => {
          try {
            await toast(`Now following ${(await follow(db, found.submitted)).title}.`);
          } catch (error) {
            if (!(error instanceof AlreadyFollowing)) {
              throw error;
            }
          }
        })
      : Promise.resolve();

  const explicit = isChannelInput(finder.term);
  const searchable = explicit || isChannelName(finder.term);
  const letters = finder.term.match(/[\p{L}\p{N}]/gu)?.length ?? 0;

  return (
    <Section
      // Until the user searches online, every row comes from the device: the heading says so, since
      // it is why a channel can be missing and why “Search online” is there.
      {...(rows.length === 0 ? {} : { heading: wider === null ? 'Suggestions on this device' : 'Suggestions' })}
      // Where the suggestions and the online search come from is the Privacy page's to say, not the list's.
      {...(!explicit && searchable ? { footer: <Link to="/settings/privacy">How search works</Link> } : {})}
    >
      {rows.map((row) => {
        const item =
          row.kind === 'own'
            ? { key: row.subscription.key, title: row.subscription.title, avatar: row.subscription.avatar, handle: row.subscription.handle, matched: undefined, description: undefined }
            : row.kind === 'named'
              ? { key: `youtube:${row.channel.id}`, title: row.channel.name, avatar: null, handle: row.channel.handle, matched: row.channel.matched, description: row.channel.description }
              : 'following' in row.found
                ? { key: row.found.following.key, title: row.found.following.title, avatar: row.found.following.avatar, handle: row.found.following.handle, matched: undefined, description: undefined }
                : { key: row.found.submitted.channel.key, title: row.found.submitted.channel.title, avatar: row.found.submitted.channel.avatar, handle: row.found.submitted.channel.handle, matched: undefined, description: undefined };
        const following = byKey.get(item.key);
        // A followed channel shows as in the user's list: its avatar, once the catalog has filled it.
        if (following !== undefined) {
          item.title = following.title;
          item.avatar = following.avatar;
        }
        const adding = busy.has(item.key);
        const details = [item.handle === null ? null : `@${item.handle}`, item.description || null].filter((part) => part !== null).join(' · ');

        return (
          <IonItem key={item.key} detail={false} {...(following === undefined ? {} : { button: true, onClick: () => onOpen(following) })}>
            <ChannelAvatar channel={item.key} title={item.title} avatar={item.avatar} slot="start" />
            <IonLabel className="ion-text-nowrap">
              <h2>{item.title}</h2>
              {/* The name the words matched, when the row's own name doesn't hold them. */}
              {item.matched !== undefined && <p className="match-name">“{item.matched}”</p>}
              {details !== '' && <p>{details}</p>}
            </IonLabel>
            {following !== undefined ? (
              <IonNote slot="end" className="following-mark">
                <IonIcon icon={checkmark} aria-hidden="true" /> Following
              </IonNote>
            ) : (
              <IonButton
                slot="end"
                size="small"
                color="dark"
                disabled={adding}
                aria-label={`Follow ${item.title}`}
                onClick={() => void (row.kind === 'named' ? followNamed(row.channel) : row.kind === 'found' ? followFound(row.found) : Promise.resolve())}
              >
                {!adding && <IonIcon slot="start" icon={add} />}
                {adding ? 'Adding…' : 'Follow'}
              </IonButton>
            )}
          </IonItem>
        );
      })}

      {wider?.status === 'searching' ? (
        <IonItem lines="none">
          <IonSpinner slot="start" name="crescent" className="search-wider-spinner" />
          <IonLabel color="medium" className="ion-text-wrap">
            {explicit ? 'Looking for this channel…' : 'Searching online…'}
            {slow && <p>This can take a few seconds.</p>}
          </IonLabel>
        </IonItem>
      ) : finder.canWiden ? (
        <IonItem lines="none" button detail={false} onClick={() => void finder.widen()}>
          <IonIcon slot="start" icon={search} color="medium" aria-hidden="true" />
          <IonLabel className="ion-text-wrap">
            <h2>{explicit ? 'Find this channel' : wider === null ? 'Search online' : 'Not there? Keep searching'}</h2>
            {!explicit && wider === null && <p>{rows.length === 0 ? `“${finder.term}” isn’t on this device. Look for it online.` : 'Not in these suggestions? Look for it online.'}</p>}
          </IonLabel>
        </IonItem>
      ) : !searchable ? (
        // The list opens with the first letter: it says what more it needs to suggest channels.
        <IonItem lines="none">
          <IonLabel color="medium" className="ion-text-wrap">
            {letters < 3 ? 'Keep typing: channels to add show from 3 letters.' : 'Type a channel’s name, @handle or link.'}
          </IonLabel>
        </IonItem>
      ) : wider?.status === 'nothing' || (wider?.status === 'done' && wider.next === null && wider.found === null) ? (
        <IonItem lines="none">
          <IonLabel color="medium">Nothing more found.</IonLabel>
        </IonItem>
      ) : null}
      {wider?.status === 'failed' && (
        <IonNote color="medium" className="ion-display-block ion-padding-horizontal ion-padding-bottom">
          Couldn’t search right now. Try again in a moment.
        </IonNote>
      )}
    </Section>
  );
}
