import { IonButton, IonChip, IonIcon, IonItem, IonLabel, IonNote, IonSpinner } from '@ionic/react';
import { guessHandles } from '@subify/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { add, checkmark, clipboardOutline, closeOutline, logoYoutube, openOutline, search } from 'ionicons/icons';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
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
 * blindly once typing pauses. Last come the options, as chips: the name's likely handles, each
 * checked on YouTube by the server on the user's tap (Enter takes the first), the one step that
 * tells the server a name, and what always works, YouTube's own search and the link copied there,
 * pasted back. A link has “Find this channel” instead.
 *
 * Nothing goes to the server in clear while typing: every lookup of a channel the catalog lacks
 * costs the server a read online, and a name being typed would be read letter by letter.
 */

/**
 * Where a name's wider search goes on from: what the device can still look up without naming it
 * (the dictionary, when it isn't on the device yet, and the name's likely handles in the catalog,
 * when the connection check kept them from being looked up as it was typed), or the server
 * reading one likely handle on YouTube, which tells it that handle. A link goes online at once.
 */
type Step = 'local' | 'online';

interface Wider {
  text: string;
  status: 'searching' | 'done' | 'failed';
  /** The step running or last run, for the row's words. */
  step: Step;
  /** The handle being checked on YouTube, or last checked. */
  handle: string | null;
  matches: NamedChannel[];
  found: FoundChannel[];
  /** The handles checked on YouTube that name no channel. */
  missed: string[];
  /** The handles that named a channel, in the catalog or on YouTube: no need to offer them. */
  hits: string[];
  /** Whether the device has looked up what typing couldn't. */
  localDone: boolean;
  /** A link that names no channel. */
  nothing: boolean;
}

export interface ChannelSearch {
  term: string;
  /** A link or a channel id: looked up as it is, with no handle to offer. */
  explicit: boolean;
  /** Whether the text can find a channel: a link, a @handle, or a name of 3 letters or more. */
  searchable: boolean;
  /** What the device found as the text was typed: the dictionary's matches, then the channel a likely handle names in the catalog. */
  suggested: NamedChannel[];
  /** The handles to offer for a name, each the user can check on YouTube. */
  handles: string[];
  /** Whether a handle or the link found a channel: the options then ask if it is the one. */
  hit: boolean;
  wider: Wider | null;
  busy: boolean;
  /** Looks a link up, or checks a handle on YouTube: the one tapped, else the first left (Enter). */
  widen(handle?: string): Promise<void>;
}

/** How many likely handles a name offers to check. */
const MAX_OFFERED = 4;

/**
 * How long typing pauses before a name's likely handles are looked up in the catalog: each lookup
 * is a blind evaluation, from a budget every device shares.
 */
const GUESS_PAUSE = 600;

/** The handles to look for blindly, and to offer: a typed @handle, or those a name likely gives. */
function guessesOf(term: string): string[] {
  const handle = localHandle(term);

  if (handle !== null) {
    return handle.length >= 3 ? [handle] : [];
  }

  if (!isChannelName(term)) {
    return [];
  }

  // A channel often adds its language or “official” to its name: suggested only, read on a tap.
  const [joined, ...others] = guessHandles(term);
  const language = navigator.language.split('-')[0]!.toLowerCase();
  const suffixed = [...(language === 'en' ? [] : [language]), 'official'].map((suffix) => `${joined}${suffix}`).filter((guess) => guess.length <= 30);

  return joined === undefined ? [] : [...new Set([joined, ...suffixed, ...others])];
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

  // A @handle typed reads like a name: it is offered, and checked on YouTube on a tap.
  const typedHandle = term.startsWith('@') && localHandle(term) !== null;
  const explicit = isChannelInput(term) && !typedHandle;
  const searchable = explicit || typedHandle || isChannelName(term);
  const guesses = guessesOf(term);
  const guessesDone = guesses.length === 0 || handleFound?.text === term;
  const current = wider?.text === term ? wider : null;
  // The handles to offer: those the catalog lacks, each checked on YouTube only on the user's tap.
  const foundByTyping = handleFound?.text === term && handleFound.channel !== null ? handleFound.channel.handle : null;
  const handles = explicit ? [] : guesses.slice(0, MAX_OFFERED).filter((handle) => handle !== foundByTyping && !(current?.hits ?? []).includes(handle));
  const busy = current?.status === 'searching';
  const typed = [...suggested, ...(handleFound?.text === term && handleFound.channel !== null ? [handleFound.channel] : [])];

  const widen = useCallback(
    async (handle?: string) => {
      const target = explicit ? null : (handle ?? handles.find((other) => !(current?.missed ?? []).includes(other)) ?? null);
      const local = !explicit && !(current?.localDone ?? false) && (!ready || !guessesDone);

      if (busy || !searchable || (!explicit && target === null && !local)) {
        return;
      }

      const id = latest.current;
      const show = (next: Wider) => {
        if (id === latest.current) {
          setWider(next);
        }
      };
      const state: Wider = current ?? { text: term, status: 'done', step: 'local', handle: null, matches: [], found: [], missed: [], hits: [], localDone: false, nothing: false };
      let step: Step = local ? 'local' : 'online';
      show({ ...state, status: 'searching', step, handle: target });

      try {
        const answer = await gate.run(api, async (): Promise<Wider> => {
          const matches = [...state.matches];

          if (step === 'local') {
            // What typing couldn't look up: found here, it shows, and the name stays off the server.
            if (!ready && ((await hasDictionary(db)) || (await ensureDictionary(db, api)))) {
              matches.push(...(await searchDictionary(db, term)));
            }

            const found = guessesDone ? null : await findHandle(api, await api.catalog(), guesses);

            if (found !== null) {
              matches.push(guessed(found));
            }

            const done = { ...state, status: 'done' as const, matches, localDone: true };

            // Found here, or the handle the user tapped is in the catalog: nothing to ask YouTube.
            if (target === null || (handle === undefined && matches.length > state.matches.length) || found?.handle === target) {
              return found === null ? done : { ...done, hits: [...state.hits, found.handle] };
            }

            step = 'online';
            show({ ...done, status: 'searching', step, handle: target });
          }

          try {
            const found = await findChannel(db, api, target === null ? term : `@${target}`);

            return { ...state, status: 'done', step, matches, localDone: true, found: [...state.found, found], hits: target === null ? state.hits : [...state.hits, target] };
          } catch (failure) {
            if (failure instanceof ServerError && (failure.code === 'channel_not_found' || failure.code === 'invalid_link')) {
              return { ...state, status: 'done', step, matches, localDone: true, missed: target === null ? state.missed : [...state.missed, target], nothing: target === null };
            }

            throw failure;
          }
        });
        show(answer);
      } catch (failure) {
        // Cancelling the connection check leaves the list as it was.
        show({ ...state, status: isCancelled(failure) ? 'done' : 'failed', step });
      }
    },
    [db, api, gate, term, current, explicit, searchable, ready, guesses, guessesDone, handles, busy],
  );

  const hit = foundByTyping !== null || (current?.found.length ?? 0) > 0;

  return { term, explicit, searchable, suggested: typed, handles, hit, wider: current, busy, widen };
}

type Row = { kind: 'own'; subscription: Subscription } | { kind: 'named'; channel: NamedChannel } | { kind: 'found'; found: FoundChannel };

/**
 * The list under the field: followed channels the text matches first, then the dictionary's
 * suggestions, then what the wider search found, each channel once, and the row that searches further.
 */
export function ChannelSearchResults({
  finder,
  own,
  onOpen,
  onPaste,
}: {
  finder: ChannelSearch;
  own: readonly Subscription[];
  onOpen(subscription: Subscription): void;
  /** A link read from the clipboard, for the field, which looks it up; null when the clipboard can't be read. */
  onPaste(link: string | null): void;
}) {
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

  for (const found of wider?.found ?? []) {
    push('following' in found ? found.following.key : found.submitted.channel.key, { kind: 'found', found });
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

  const { explicit, searchable } = finder;

  // The link the user copied in YouTube: read on their tap, never otherwise.
  const paste = async () => {
    let text: string | null = null;

    try {
      text = (await navigator.clipboard.readText()).trim();
    } catch {
      // Refused or unsupported: the user pastes in the field.
    }

    if (text !== null && !isChannelInput(text)) {
      await toast('Copy the link of a YouTube channel or video first.');
    } else {
      onPaste(text);

      if (text === null) {
        await toast('Paste the link in the search field.');
      }
    }
  };
  // YouTube's own search, in the browser or its app: the user's visit, which YouTube sees as usual.
  const openYoutube = () =>
    void window.open(
      explicit ? 'https://www.youtube.com/' : `https://www.youtube.com/results?search_query=${encodeURIComponent(finder.term)}&sp=EgIQAg%253D%253D`,
      '_blank',
      'noopener,noreferrer',
    );
  const letters = finder.term.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  // The handles still worth a tap, and what the options' heading says of the search so far.
  const left = finder.handles.filter((handle) => !(wider?.missed ?? []).includes(handle));
  const optionsTitle =
    rows.length === 0 ? (left.length === 0 ? 'No channel found' : 'Nothing found yet') : finder.hit ? 'Not the one?' : left.length === 0 && (wider?.missed.length ?? 0) > 0 ? 'Nothing more found' : 'Not listed?';

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
            {explicit ? 'Looking for this channel…' : wider.step === 'local' ? `Looking for “${finder.term}”…` : `Checking YouTube for @${wider.handle}…`}
            {slow && <p>This can take a few seconds.</p>}
          </IonLabel>
        </IonItem>
      ) : explicit && !(wider?.nothing ?? false) ? (
        wider?.found.length ? null : (
          <IonItem lines="none" button detail={false} onClick={() => void finder.widen()}>
            <IonIcon slot="start" icon={search} color="medium" aria-hidden="true" />
            <IonLabel>
              <h2>Find this channel</h2>
            </IonLabel>
          </IonItem>
        )
      ) : !searchable ? (
        // The list opens with the first letter: it says what more it needs to suggest channels.
        <IonItem lines="none">
          <IonLabel color="medium" className="ion-text-wrap">
            {letters < 3 ? 'Keep typing: channels to add show from 3 letters.' : 'Type a channel’s name, or paste its link.'}
          </IonLabel>
        </IonItem>
      ) : (
        <Options title={optionsTitle}>
          {left.length > 0 && (
            // The one step that tells the server a name: the one the user taps, knowing what it sees.
            <>
              <p>Is it one of these on YouTube? The server sees the one you tap, not who you are.</p>
              <div className="search-options">
                {finder.handles.map((handle) => {
                  const missed = (wider?.missed ?? []).includes(handle);

                  return (
                    <IonChip key={handle} outline disabled={missed} onClick={() => void finder.widen(handle)} aria-label={missed ? `@${handle}: no channel` : `Check @${handle} on YouTube`}>
                      <IonIcon icon={missed ? closeOutline : logoYoutube} aria-hidden="true" />@{handle}
                    </IonChip>
                  );
                })}
              </div>
            </>
          )}
          {/* What always works: the channel's link, or one of its videos', copied in YouTube. */}
          {/* It leaves the app: the line says so before the tap, and where it lands. */}
          <p>
            {left.length > 0 ? 'Or look' : explicit ? 'Check the link, or look' : rows.length === 0 ? 'Check the spelling, or look' : 'Look'} for it in YouTube: this
            leaves Subify and opens the YouTube app, or its website. There, tap Share, then Copy link, and come back here to paste it.
          </p>
          <div className="search-options">
            <IonChip outline onClick={openYoutube} aria-label={`Open YouTube to look for “${finder.term}”, outside Subify`}>
              <IonIcon icon={logoYoutube} aria-hidden="true" />
              Open YouTube
              <IonIcon icon={openOutline} aria-hidden="true" />
            </IonChip>
            <IonChip outline onClick={() => void paste()}>
              <IonIcon icon={clipboardOutline} aria-hidden="true" />
              Paste link
            </IonChip>
          </div>
        </Options>
      )}
      {wider?.status === 'failed' && (
        <IonNote color="medium" className="ion-display-block ion-padding-horizontal ion-padding-bottom">
          Couldn’t search right now. Try again in a moment.
        </IonNote>
      )}
    </Section>
  );
}

/** Where the search goes on: each kind of option, a line on what it does, then its chips. */
function Options({ title, children }: { title: string; children: ReactNode }) {
  return (
    <IonItem lines="none">
      <IonLabel className="ion-text-wrap search-options-card">
        <h2>{title}</h2>
        {children}
      </IonLabel>
    </IonItem>
  );
}
