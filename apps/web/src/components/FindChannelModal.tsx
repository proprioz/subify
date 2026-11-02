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
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import Dexie from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { add, search } from 'ionicons/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppData } from '../app/AppData';
import { ServerError } from '../data/api';
import { isChannelInput, isChannelName } from '../data/channel-link';
import { isCancelled } from '../data/connection-check';
import type { Subscription } from '../data/db';
import { ensureDictionary, hasDictionary, type NamedChannel, searchDictionary } from '../data/dictionary';
import { ageLabel } from '../data/format';
import { AlreadyFollowing, type FoundChannel, findChannel, follow, TooManyChannels } from '../data/subscriptions';

/** Where a name's lookup goes on from: the dictionary, the search services, or the server's guessed handles. */
type Step = 'dictionary' | 'search' | 'guess';
import { useToast } from '../ui/toast';
import { ChannelAvatar } from './ChannelAvatar';
import { Section } from './Section';

type Result =
  | { status: 'searching' }
  | { status: 'found'; found: FoundChannel }
  /** Channels the dictionary or a search service names like this: one is looked up once chosen; `next` if none is the one. */
  | { status: 'matches'; matches: NamedChannel[]; next: Step }
  | { status: 'failed'; message: string };

/** The window's state while it is open: its field, what was looked up for it, and how many channels were followed from it. */
interface Finding {
  text: string;
  result: Result | null;
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
  const { db, api, gate } = useAppData();
  const toast = useToast();
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
      const show = (result: Result) => {
        if (id === latest.current) {
          setFinding((current) => ({ text: current?.text ?? query, result, followed: current?.followed ?? 0 }));
        }
      };

      try {
        const result = await gate.run(api, async (): Promise<Result> => {
          show({ status: 'searching' });

          if (from === 'dictionary' && isChannelName(query) && (await ensureDictionary(db, api))) {
            const matches = await searchDictionary(db, query);

            if (matches.length > 0) {
              return { status: 'matches', matches, next: 'search' };
            }
          }

          const found = await findChannel(db, api, query, { search: from !== 'guess' });

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
    setFinding((current) => current && { ...current, text, result: null });
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

  return { finding, lookUp, edit, followFound, close };
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
          <div className="ion-padding ion-text-center">
            <IonSpinner aria-label="Looking up…" />
          </div>
        ) : result.status === 'failed' ? (
          <Hint alert>{result.message}</Hint>
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
          <FoundRow found={result.found} onFollow={() => void finder.followFound()} />
        )}
      </IonContent>
    </IonModal>
  );
}

function FoundRow({ found, onFollow }: { found: FoundChannel; onFollow(): void }) {
  const { db } = useAppData();
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
    channel.handle === null ? null : `@${channel.handle}`,
    latest === undefined ? null : latest === null ? 'No uploads yet' : `Last upload ${ageLabel(latest)}`,
  ].filter((detail) => detail !== null);

  return (
    <IonList inset>
      <IonItem lines="none">
        <ChannelAvatar title={channel.title} avatar={channel.avatar} slot="start" />
        <IonLabel>
          <h2>{channel.title}</h2>
          {details.length > 0 && <p>{details.join(' · ')}</p>}
        </IonLabel>
        {'following' in found ? (
          <IonNote slot="end" color="medium">
            Following
          </IonNote>
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

/** The channels the dictionary names like `text`, once the device has it: searched while typing, offline. */
export function NameMatches({ text, onPick }: { text: string; onPick(channel: NamedChannel): void }) {
  const { db } = useAppData();
  const [matches, setMatches] = useState<NamedChannel[]>([]);

  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      void (async () => {
        const found = isChannelName(text) && (await hasDictionary(db)) ? await searchDictionary(db, text, 5) : [];

        if (current) {
          setMatches(found);
        }
      })();
    }, 150);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [db, text]);

  return matches.length === 0 ? null : <MatchList heading="Channels with this name" matches={matches} onPick={onPick} />;
}

function MatchList({ heading, matches, onPick }: { heading?: string; matches: NamedChannel[]; onPick(channel: NamedChannel): void }) {
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
