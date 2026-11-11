import { IonButton, IonIcon, IonItem, IonLabel, IonNote, IonSpinner } from '@ionic/react';
import { guessHandles } from '@subify/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { add, checkmark, linkOutline, logoYoutube, search } from 'ionicons/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { ServerError } from '../data/api';
import { isChannelInput, isChannelName, localHandle } from '../data/channel-link';
import { isCancelled } from '../data/connection-check';
import type { Subscription } from '../data/db';
import { ensureDictionary, hasDictionary, type NamedChannel, searchDictionary } from '../data/dictionary';
import { findHandle } from '../data/encrypted';
import { followOne } from '../data/follow-many';
import { AlreadyFollowing, type FoundChannel, findChannel, follow, TooManyChannels } from '../data/subscriptions';
import { useToast } from '../ui/toast';
import { ChannelAvatar } from './ChannelAvatar';
import { Section } from './Section';

/**
 * Adding a channel (docs/FEATURES.md, §2): one list under the Channels tab's field, as a search
 * box's suggestions. It holds the followed channels the text matches, marked “Following”, the
 * channels the Wikidata dictionary names like it, searched on the device while it is typed, each
 * with “Follow”, then the channel a likely handle of the name names in the catalog, looked up
 * blindly once typing pauses. Last comes the one step that tells the server the name: checking
 * YouTube for its likely handles (“Check YouTube for @…”), the user's action, its row or Enter,
 * which says what the server sees. A link has “Find this channel” instead.
 *
 * Nothing goes to the server in clear while typing: every lookup of a channel the catalog lacks
 * costs the server a read online, and a name being typed would be read letter by letter.
 */

/**
 * Where a name's wider search goes on from: what the device can still look up without naming it
 * (the dictionary, when it isn't on the device yet, and the name's likely handles in the catalog,
 * when the connection check kept them from being looked up as it was typed), or the server
 * reading the likely handles on YouTube, which tells it the name. A link goes online at once.
 */
type Step = 'local' | 'online';

interface Wider {
  text: string;
  status: 'searching' | 'done' | 'nothing' | 'failed';
  /** The step running or last run, for the row's words. */
  step: Step;
  matches: NamedChannel[];
  found: FoundChannel | null;
  /** The next step a name can go on to, or null when there is none left. */
  next: Step | null;
}

export interface ChannelSearch {
  term: string;
  /** What the device found as the text was typed: the dictionary's matches, then the channel a likely handle names in the catalog. */
  suggested: NamedChannel[];
  /** The handle the server would read on YouTube first, for a name: what its row says. */
  firstGuess: string | null;
  wider: Wider | null;
  /** Whether the search can go further for this text. */
  canWiden: boolean;
  widen(): Promise<void>;
}

/**
 * How long typing pauses before a name's likely handles are looked up in the catalog: each lookup
 * is a blind evaluation, from a budget every device shares.
 */
const GUESS_PAUSE = 600;

/** The handles to look for blindly: a typed @handle, or those a name likely gives. */
function guessesOf(term: string): string[] {
  const handle = localHandle(term);

  return handle !== null ? (handle.length >= 3 ? [handle] : []) : isChannelName(term) ? guessHandles(term) : [];
}

function guessed(found: { key: string; handle: string }): NamedChannel {
  return { id: found.key.slice(found.key.indexOf(':') + 1), handle: found.handle, name: `@${found.handle}` };
}

/** The suggestions for the field's text, and its wider search. */
export function useChannelSearch(text: string): ChannelSearch {
  const { db, api, gate } = useAppData();
  const term = text.trim();
  const [suggested, setSuggested] = useState<NamedChannel[]>([]);
  const [handleFound, setHandleFound] = useState<{ text: string; channel: NamedChannel | null } | null>(null);
  const [wider, setWider] = useState<Wider | null>(null);
  // The dictionary may arrive while the name is being typed: the matches then show without another key.
  const ready = useLiveQuery(() => hasDictionary(db), [db]) ?? false;
  // Each new text moves this on, so a late answer never shows under newer text.
  const latest = useRef(0);
  // What each text's guesses found, so that typing back to a name asks nothing again.
  const looked = useRef(new Map<string, NamedChannel | null>());

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

  // A name's likely handles, looked up blindly in the catalog once typing pauses: the server learns
  // nothing of them. Never asks: with the connection check on and nothing approved yet, the wider
  // search looks them up. A failure (the shared budget spent, no index yet) leaves it to it too.
  useEffect(() => {
    const handles = guessesOf(term);
    const known = looked.current.get(term);

    if (handles.length === 0 || known !== undefined) {
      setHandleFound(known === undefined ? null : { text: term, channel: known });

      return;
    }

    let current = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const found = await gate.whenApproved(async () => findHandle(api, await api.catalog(), handles));

          if (found !== undefined) {
            const channel = found === null ? null : guessed(found);
            looked.current.set(term, channel);

            if (current) {
              setHandleFound({ text: term, channel });
            }
          }
        } catch {
          // Suggestions are best effort: the wider search looks again.
        }
      })();
    }, GUESS_PAUSE);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, gate, term]);

  const explicit = isChannelInput(term);
  const searchable = explicit || isChannelName(term);
  const guessesDone = guessesOf(term).length === 0 || handleFound?.text === term;
  // A likely handle found in the catalog: YouTube would only read the same page again.
  const guessFound = handleFound?.text === term && handleFound.channel !== null;
  const canWiden = searchable && !guessFound && (wider === null || (wider.status !== 'searching' && wider.next !== null));
  const typed = [...suggested, ...(handleFound?.text === term && handleFound.channel !== null ? [handleFound.channel] : [])];

  const widen = useCallback(async () => {
    if (!canWiden) {
      return;
    }

    const id = latest.current;
    const show = (next: Wider) => {
      if (id === latest.current) {
        setWider(next);
      }
    };
    let step: Step = explicit ? 'online' : (wider?.next ?? (ready && guessesDone ? 'online' : 'local'));
    const previous = { matches: wider?.matches ?? [], found: wider?.found ?? null };
    show({ text: term, status: 'searching', step, ...previous, next: step });

    try {
      const answer = await gate.run(api, async (): Promise<Omit<Wider, 'text'>> => {
        if (step === 'local') {
          // What typing couldn't look up: found here, it shows, and the name stays off the server.
          const matches = [...previous.matches];

          if (!ready && ((await hasDictionary(db)) || (await ensureDictionary(db, api)))) {
            matches.push(...(await searchDictionary(db, term)));
          }

          const found = guessesDone ? null : await findHandle(api, await api.catalog(), guessesOf(term));

          if (found !== null) {
            matches.push(guessed(found));
          }

          if (matches.length > previous.matches.length) {
            return { status: 'done', step, matches, found: previous.found, next: 'online' };
          }

          // Nothing: the user asked for YouTube, so the search goes on there.
          step = 'online';
          show({ text: term, status: 'searching', step, ...previous, next: step });
        }

        return { status: 'done', step, ...previous, found: await findChannel(db, api, term), next: null };
      });
      show({ text: term, ...answer });
    } catch (failure) {
      // Cancelling the connection check leaves the list as it was.
      if (isCancelled(failure)) {
        show({ text: term, status: 'done', step, ...previous, next: step });
      } else {
        const nothing = failure instanceof ServerError && (failure.code === 'channel_not_found' || failure.code === 'invalid_link');
        show({ text: term, status: nothing ? 'nothing' : 'failed', step, ...previous, next: nothing ? null : step });
      }
    }
  }, [db, api, gate, term, wider, explicit, ready, guessesDone, canWiden]);

  return { term, suggested: typed, firstGuess: guessesOf(term)[0] ?? null, wider: wider?.text === term ? wider : null, canWiden, widen };
}

type Row = { kind: 'own'; subscription: Subscription } | { kind: 'named'; channel: NamedChannel } | { kind: 'found'; found: FoundChannel };

/**
 * The list under the field: followed channels the text matches first, then the dictionary's
 * suggestions, then what the wider search found, each channel once, and the row that searches further.
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

  // A channel the catalog has is filled at once, blindly, with its thumbnails; another waits in
  // the import queue, which adds it in the background.
  const followNamed = (channel: NamedChannel) =>
    withBusy(`youtube:${channel.id}`, async () => {
      const { queued } = await gate.run(api, () => followOne(db, api, { key: `youtube:${channel.id}`, title: channel.name, handle: channel.handle }));
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
      // Where the rows come from is the Privacy page's to say: the user only sees suggestions, then one way further.
      {...(rows.length === 0 ? {} : { heading: 'Suggestions' })}
      // Where the suggestions and the online search come from is the Privacy page's to say, not the list's.
      {...(!explicit && searchable ? { footer: <Link to="/settings/privacy">How search works</Link> } : {})}
    >
      {rows.map((row) => {
        const item =
          row.kind === 'own'
            ? { key: row.subscription.key, title: row.subscription.title, avatar: row.subscription.avatar, handle: row.subscription.handle, matched: undefined }
            : row.kind === 'named'
              ? { key: `youtube:${row.channel.id}`, title: row.channel.name, avatar: null, handle: row.channel.handle, matched: row.channel.matched }
              : 'following' in row.found
                ? { key: row.found.following.key, title: row.found.following.title, avatar: row.found.following.avatar, handle: row.found.following.handle, matched: undefined }
                : { key: row.found.submitted.channel.key, title: row.found.submitted.channel.title, avatar: row.found.submitted.channel.avatar, handle: row.found.submitted.channel.handle, matched: undefined };
        const following = byKey.get(item.key);
        // A followed channel shows as in the user's list: its avatar, once the catalog has filled it.
        if (following !== undefined) {
          item.title = following.title;
          item.avatar = following.avatar;
        }
        const adding = busy.has(item.key);
        // A channel found by its likely handle is named by it until followed: its handle once is enough.
        const details = item.handle === null || item.title === `@${item.handle}` ? '' : `@${item.handle}`;

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
            {explicit ? 'Looking for this channel…' : wider.step === 'local' ? `Looking for “${finder.term}”…` : `Checking YouTube for @${finder.firstGuess}…`}
            {slow && <p>This can take a few seconds.</p>}
          </IonLabel>
        </IonItem>
      ) : explicit && finder.canWiden ? (
        <IonItem lines="none" button detail={false} onClick={() => void finder.widen()}>
          <IonIcon slot="start" icon={search} color="medium" aria-hidden="true" />
          <IonLabel>
            <h2>Find this channel</h2>
          </IonLabel>
        </IonItem>
      ) : !searchable ? (
        // The list opens with the first letter: it says what more it needs to suggest channels.
        <IonItem lines="none">
          <IonLabel color="medium" className="ion-text-wrap">
            {letters < 3 ? 'Keep typing: channels to add show from 3 letters.' : 'Type a channel’s name, @handle or link.'}
          </IonLabel>
        </IonItem>
      ) : finder.canWiden && finder.firstGuess !== null ? (
        // The one step that tells the server the name: the user takes it, knowing what it sees.
        <IonItem lines="none" button detail={false} onClick={() => void finder.widen()}>
          <IonIcon slot="start" icon={logoYoutube} color="medium" aria-hidden="true" />
          <IonLabel className="ion-text-wrap">
            <h2>{rows.length === 0 ? '' : 'Not listed? '}Check YouTube for @{finder.firstGuess}</h2>
            <p>The server will see this name, not who you are.</p>
          </IonLabel>
        </IonItem>
      ) : rows.length === 0 || wider?.status === 'nothing' || (wider?.status === 'done' && wider.found === null) ? (
        <LinkHint lead={rows.length === 0 ? 'No channel found' : 'Nothing more found'} />
      ) : wider === null && !explicit ? (
        // A likely handle found the channel: the link still finds another one.
        <LinkHint lead="Not the one?" />
      ) : null}
      {wider?.status === 'failed' && (
        <IonNote color="medium" className="ion-display-block ion-padding-horizontal ion-padding-bottom">
          Couldn’t search right now. Try again in a moment.
        </IonNote>
      )}
    </Section>
  );
}

/** What always finds a channel when its name doesn't: its link, pasted in the same field. */
function LinkHint({ lead }: { lead: string }) {
  return (
    <IonItem lines="none">
      <IonIcon slot="start" icon={linkOutline} color="medium" aria-hidden="true" />
      <IonLabel className="ion-text-wrap">
        <h2>{lead}</h2>
        <p>Check the spelling, or paste the channel’s link. In YouTube, open the channel, then ⋮ › Share › Copy link.</p>
      </IonLabel>
    </IonItem>
  );
}
