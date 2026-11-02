import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonSearchbar,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import Dexie from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { add, playOutline, search } from 'ionicons/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { ServerError } from '../data/api';
import { isChannelInput, isChannelName } from '../data/channel-link';
import { isCancelled } from '../data/connection-check';
import type { Subscription } from '../data/db';
import { ensureDictionary, hasDictionary, type NamedChannel, searchDictionary } from '../data/dictionary';
import { ageLabel } from '../data/format';
import { AlreadyFollowing, type FoundChannel, findChannel, follow, type LookUpStep, TooManyChannels } from '../data/subscriptions';

/** Where a name's lookup goes on from: the dictionary, the search services, or the server's guessed handles. */
type Step = 'dictionary' | 'search' | 'guess';
import { useToast } from '../ui/toast';
import { ChannelAvatar } from './ChannelAvatar';
import { type LogEntry, LookUpLog, LookUpProgress } from './LookUpProgress';
import { Section } from './Section';

type Result =
  | { status: 'searching' }
  | { status: 'found'; found: FoundChannel }
  /** Channels the dictionary or a search service names like this: one is looked up once chosen; `next` if none is the one. */
  | { status: 'matches'; matches: NamedChannel[]; next: Step }
  | { status: 'failed'; message: string };

/**
 * The window's state while it is open: its field, what was looked up for it, the steps that took
 * and when they ended, and how many channels were followed from it.
 */
interface Finding {
  text: string;
  result: Result | null;
  log: LogEntry[];
  ended?: number;
  followed: number;
}

export interface ChannelFinder {
  finding: Finding | null;
  /**
   * Looks the text up, once the connection is approved, and opens the window on the answer. A name
   * is looked for from `from` on: the dictionary on the device first, then the search services.
   */
  lookUp(text: string, from?: Step): Promise<void>;
  edit(text: string): void;
  followFound(): Promise<void>;
  /** Closes the window on the feed of a channel followed. */
  showVideos(channel: Subscription): void;
  close(): void;
}

/**
 * How a channel is added: the page's field offers to look the text up online, the
 * results open over the page, and the user follows the channel from there. They stay open after
 * following one, so several can be added in a row.
 *
 * Searching channels by name would need YouTube's internal API, which this app never uses: a
 * name is looked for in the Wikidata dictionary, downloaded whole at the first name looked up and
 * searched on the device, then as the @handles it likely gives in the catalog, then on the search
 * services the server's admin turned on, and last read online as those handles. Only
 * from its button, since the same words search the list. Nothing is looked up online while typing:
 * every lookup of a channel the catalog lacks costs the server a read online, and a handle being
 * typed would be read letter by letter.
 */
export function useChannelFinder(onClosed: () => void): ChannelFinder {
  const { db, api, gate, setSecretOpened } = useAppData();
  const toast = useToast();
  const navigate = useNavigate();
  const [finding, setFinding] = useState<Finding | null>(null);
  // Each lookup, edit or close moves this on, so a late answer never shows over newer text.
  const latest = useRef(0);

  const lookUp = useCallback(
    async (text: string, from: Step = 'dictionary') => {
      const query = text.trim();

      if (!isChannelInput(query) && !isChannelName(query)) {
        return;
      }

      const id = ++latest.current;
      const log: LogEntry[] = [];
      const show = (result: Result) => {
        if (id === latest.current) {
          const ended = result.status === 'searching' ? {} : { ended: Date.now() };
          setFinding((current) => ({ text: current?.text ?? query, result, log: [...log], ...ended, followed: current?.followed ?? 0 }));
        }
      };
      // Another part of the same step (a slice, a chunk) continues its line.
      const onStep = (step: LookUpStep) => {
        const last = log.at(-1);

        if (last?.step.kind === step.kind) {
          log[log.length - 1] = { ...last, step };
        } else {
          log.push({ step, at: Date.now() });
        }

        show({ status: 'searching' });
      };

      try {
        const result = await gate.run(api, async (): Promise<Result> => {
          show({ status: 'searching' });

          if (from === 'dictionary' && isChannelName(query) && (await ensureDictionary(db, api, onStep))) {
            onStep({ kind: 'local' });
            const matches = await searchDictionary(db, query);

            if (matches.length > 0) {
              return { status: 'matches', matches, next: 'search' };
            }
          }

          const found = await findChannel(db, api, query, { search: from !== 'guess', onStep });

          return 'matches' in found ? { status: 'matches', matches: found.matches, next: 'guess' } : { status: 'found', found };
        });
        show(result);
      } catch (failure) {
        // Cancelling the connection check leaves the page, or the open window, as it was.
        if (!isCancelled(failure)) {
          show({ status: 'failed', message: failure instanceof ServerError ? failure.message : 'Couldn’t look up this channel.' });
        }
      }
    },
    [db, api, gate],
  );

  const edit = useCallback((text: string) => {
    latest.current += 1;
    setFinding((current) => current && { ...current, text, result: null, log: [] });
  }, []);

  const followFound = useCallback(async () => {
    const result = finding?.result;

    if (result?.status !== 'found' || !('submitted' in result.found)) {
      return;
    }

    let following: Subscription;
    let followed = 0;

    try {
      following = await follow(db, result.found.submitted);
      followed = 1;
      await toast(`Now following ${following.title}.`);
    } catch (failure) {
      if (failure instanceof TooManyChannels) {
        await toast(failure.message);

        return;
      }

      if (!(failure instanceof AlreadyFollowing)) {
        throw failure;
      }

      following = failure.subscription;
    }

    setFinding((current) => current && { ...current, result: { status: 'found', found: { following } }, followed: current.followed + followed });
  }, [db, finding, toast]);

  const close = useCallback(() => {
    latest.current += 1;
    setFinding(null);
    onClosed();
  }, [onClosed]);

  // Leaving for the feed hides the secret channels, as from the channel list: a secret one opened
  // here stays on its own.
  const showVideos = useCallback(
    (channel: Subscription) => {
      close();
      setSecretOpened(channel.secret ? channel.key : null);
      navigate(`/feed?channel=${encodeURIComponent(channel.key)}`);
    },
    [close, navigate, setSecretOpened],
  );

  return { finding, lookUp, edit, followFound, showVideos, close };
}

/** The button that sends a link, a @handle or a name online, on the page and in the window. */
export function LookUpButton({ text, disabled = false, onClick }: { text: string; disabled?: boolean; onClick(): void }) {
  const query = text.trim();

  return (
    <IonButton expand="block" color="red" disabled={disabled} onClick={onClick}>
      <IonIcon slot="start" icon={search} />
      {isChannelName(query) ? `Look up “${query}” online` : query.startsWith('@') ? `Look up ${query} online` : 'Look up this link online'}
    </IonButton>
  );
}

export function FindChannelModal({ finder }: { finder: ChannelFinder }) {
  const { finding } = finder;
  const text = finding?.text.trim() ?? '';
  const result = finding?.result ?? null;

  return (
    <IonModal isOpen={finding !== null} onDidDismiss={finder.close}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Find channels</IonTitle>
          <IonButtons slot="end">
            <IonButton strong={(finding?.followed ?? 0) > 0} onClick={finder.close}>
              {(finding?.followed ?? 0) > 0 ? 'Done' : 'Close'}
            </IonButton>
          </IonButtons>
        </IonToolbar>
        <IonToolbar>
          <IonSearchbar
            placeholder="Channel name, @handle or link"
            aria-label="Channel name, @handle or link"
            autocapitalize="off"
            autocorrect={false}
            spellcheck={false}
            enterkeyhint="search"
            value={finding?.text ?? ''}
            onIonInput={(event) => finder.edit(String(event.detail.value ?? ''))}
            onKeyDown={(event) => {
              // Enter only sends what can't be words to search: a name goes from its button.
              if (event.key === 'Enter' && isChannelInput(text)) {
                void finder.lookUp(text);
              }
            }}
          />
        </IonToolbar>
      </IonHeader>
      <IonContent>
        {result === null ? (
          text === '' ? (
            <Hint>Type a channel’s name or @handle, or paste a link to it or one of its videos.</Hint>
          ) : isChannelInput(text) || isChannelName(text) ? (
            <>
              <div className="ion-padding">
                <LookUpButton text={text} onClick={() => void finder.lookUp(text)} />
              </div>
              <NameMatches text={text} onPick={(channel) => void finder.lookUp(channelLink(channel))} />
            </>
          ) : (
            <Hint>Type at least 3 letters of the channel’s name, or paste its link.</Hint>
          )
        ) : result.status === 'searching' ? (
          <LookUpProgress log={finding?.log ?? []} />
        ) : result.status === 'failed' ? (
          <>
            <Hint alert>{result.message}</Hint>
            {/* Like a search engine's “Did you mean”: names close to it that the device knows. */}
            <NameMatches text={text} onPick={(channel) => void finder.lookUp(channelLink(channel))} />
          </>
        ) : result.status === 'matches' ? (
          <>
            <MatchList matches={result.matches} onPick={(channel) => void finder.lookUp(channelLink(channel))} />
            <div className="ion-padding-horizontal ion-text-center">
              <IonButton fill="clear" size="small" onClick={() => void finder.lookUp(text, result.next)}>
                Not listed? Look up “{text}” online
              </IonButton>
            </div>
          </>
        ) : (
          <>
            <FoundRow found={result.found} onFollow={() => void finder.followFound()} onShow={finder.showVideos} />
            <NameMatches
              text={text}
              exclude={'following' in result.found ? result.found.following.key : result.found.submitted.channel.key}
              onPick={(channel) => void finder.lookUp(channelLink(channel))}
            />
          </>
        )}
        {result !== null && result.status !== 'searching' && (
          <div className="ion-text-center">
            <LookUpLog log={finding?.log ?? []} failed={result.status === 'failed'} {...(finding?.ended === undefined ? {} : { ended: finding.ended })} />
          </div>
        )}
      </IonContent>
    </IonModal>
  );
}

function FoundRow({ found, onFollow, onShow }: { found: FoundChannel; onFollow(): void; onShow(channel: Subscription): void }) {
  const { db, secretsShown } = useAppData();
  const channel = 'following' in found ? found.following : found.submitted.channel;
  // How lively the channel is, as the channel list says: from the answer before following, from
  // the device once followed.
  const stored = useLiveQuery(
    async () =>
      'following' in found
        ? (await db.items.where('[channel+published]').between([channel.key, Dexie.minKey], [channel.key, Dexie.maxKey]).last())?.published ?? null
        : undefined,
    [db, found],
  );
  const answered = 'submitted' in found && found.submitted.items.length > 0 ? Math.max(...found.submitted.items.map((item) => item.published)) : null;
  const latest = 'submitted' in found ? answered : stored;
  const details = [
    'following' in found ? 'Following' : null,
    channel.handle === null ? null : `@${channel.handle}`,
    latest === undefined ? null : latest === null ? 'No uploads yet' : `Last upload ${ageLabel(latest)}`,
  ].filter((detail) => detail !== null);

  // A channel followed opens its feed from here, as from the channel list; a secret one only while
  // the secret channels show.
  const following = 'following' in found ? found.following : null;
  const showable = following !== null && (!following.secret || secretsShown);

  return (
    <IonList inset>
      <IonItem lines="none" button={showable} detail={false} {...(showable ? { onClick: () => onShow(following) } : {})}>
        <ChannelAvatar title={channel.title} avatar={channel.avatar} slot="start" />
        <IonLabel>
          <h2>{channel.title}</h2>
          {details.length > 0 && <p>{details.join(' · ')}</p>}
        </IonLabel>
        {following !== null ? (
          showable && (
            <IonButton slot="end" size="small" fill="outline" aria-label={`Show videos of ${channel.title}`}>
              <IonIcon slot="start" icon={playOutline} />
              Videos
            </IonButton>
          )
        ) : (
          <IonButton slot="end" size="small" aria-label={`Follow ${channel.title}`} onClick={onFollow}>
            <IonIcon slot="start" icon={add} />
            Follow
          </IonButton>
        )}
      </IonItem>
    </IonList>
  );
}

export function channelLink(channel: NamedChannel): string {
  return `https://www.youtube.com/channel/${channel.id}`;
}

/**
 * The channels the dictionary names like `text`, once the device has it: searched while typing,
 * offline, typos included. A @handle is searched too, without its @.
 */
export function NameMatches({ text, exclude, onPick }: { text: string; exclude?: string; onPick(channel: NamedChannel): void }) {
  const { db } = useAppData();
  const [matches, setMatches] = useState<NamedChannel[]>([]);

  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      void (async () => {
        const words = isChannelName(text) || /^@[\w.-]{3,}$/.test(text.trim()) ? text : '';
        const found = words !== '' && (await hasDictionary(db)) ? await searchDictionary(db, words, 6) : [];

        if (current) {
          setMatches(found.filter((channel) => `youtube:${channel.id}` !== exclude).slice(0, 5));
        }
      })();
    }, 150);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [db, text, exclude]);

  // Next to a channel found, names a typo away are other channels rather than what was meant.
  return matches.length === 0 ? null : (
    <MatchList
      heading={exclude === undefined ? 'Channels with this name' : 'Other channels with this name'}
      {...(exclude === undefined ? {} : { similarHeading: 'Similar names' })}
      matches={matches}
      onPick={onPick}
    />
  );
}

/** Channels to choose from: those named as typed first, then those a typo away, apart, as a search engine suggests them. */
function MatchList({
  heading,
  similarHeading,
  matches,
  onPick,
}: {
  heading?: string;
  similarHeading?: string;
  matches: NamedChannel[];
  onPick(channel: NamedChannel): void;
}) {
  const named = matches.filter((channel) => channel.similar !== true);
  const similar = matches.filter((channel) => channel.similar === true);

  return (
    <>
      {named.length > 0 && <MatchSection {...(heading === undefined ? {} : { heading })} matches={named} onPick={onPick} />}
      {similar.length > 0 && <MatchSection heading={similarHeading ?? (named.length > 0 ? 'Similar names' : 'Did you mean…')} matches={similar} onPick={onPick} />}
    </>
  );
}

function MatchSection({ heading, matches, onPick }: { heading?: string; matches: NamedChannel[]; onPick(channel: NamedChannel): void }) {
  return (
    <Section {...(heading === undefined ? {} : { heading })}>
      {matches.map((channel, index) => (
        <IonItem key={channel.id} button {...(index === matches.length - 1 ? { lines: 'none' as const } : {})} onClick={() => onPick(channel)}>
          <ChannelAvatar title={channel.name} avatar={null} slot="start" />
          <IonLabel>
            <h2>{channel.name}</h2>
            {(channel.handle !== null || (channel.description ?? '') !== '') && <p>{[channel.handle === null ? null : `@${channel.handle}`, channel.description || null].filter((part) => part !== null).join(' · ')}</p>}
          </IonLabel>
        </IonItem>
      ))}
    </Section>
  );
}

function Hint({ alert = false, children }: { alert?: boolean; children: string }) {
  return (
    <IonNote color={alert ? 'danger' : 'medium'} className="ion-display-block ion-padding ion-text-center" {...(alert ? { role: 'alert' } : {})}>
      {children}
    </IonNote>
  );
}
