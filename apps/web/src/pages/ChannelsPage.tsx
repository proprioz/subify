import {
  IonButton,
  IonCard,
  IonCardContent,
  IonIcon,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonLabel,
  IonSearchbar,
  useIonAlert,
  useIonViewDidLeave,
  useIonViewWillLeave,
} from '@ionic/react';
import Dexie from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  eyeOffOutline,
  eyeOutline,
  lockClosedOutline,
  optionsOutline,
  people,
  playOutline,
  refreshOutline,
  swapVerticalOutline,
  trashOutline,
} from 'ionicons/icons';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { useSecretFlow } from '../app/SecretFlow';
import { ChannelAvatar } from '../components/ChannelAvatar';
import { ChannelSearchResults, useChannelSearch } from '../components/ChannelSearch';
import { ChannelTypesModal } from '../components/ChannelTypesModal';
import { EmptyState } from '../components/EmptyState';
import { JoiningInfo, NotFetchedInfo, refreshHint, RetryInfo } from '../components/InfoButton';
import { Menu, type MenuAction } from '../components/Menu';
import { Page } from '../components/Page';
import { SecretsBanner } from '../components/SecretsBanner';
import { SecretTour } from '../components/SecretTour';
import { Section } from '../components/Section';
import { SortMenu } from '../components/SortMenu';
import { getMeta, setMeta, type Subscription } from '../data/db';
import { dismissSecretCard, secretCardDue } from '../data/secret';
import { refreshDictionary } from '../data/dictionary';
import { type ChannelSort, sortChannels } from '../data/feed';
import { ageLabel } from '../data/format';
import { joining, unsubscribe } from '../data/subscriptions';
import { MORE_ICON } from '../ui/icons';

export function ChannelsPage() {
  const { db, api, gate, secretsShown, setSecretsShown, setSecretOpened } = useAppData();
  const { toggleSecrets, setChannelSecret, lockSecrets, secretLock } = useSecretFlow();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [presentAlert] = useIonAlert();
  const searchbar = useRef<HTMLIonSearchbarElement>(null);
  const [search, setSearch] = useState('');
  const finder = useChannelSearch(search);
  // A link pasted from the list's chip is looked up at once, as if Enter had followed it.
  const [findPasted, setFindPasted] = useState<string | null>(null);
  useEffect(() => {
    if (findPasted !== null && finder.term === findPasted) {
      setFindPasted(null);
      void finder.widen();
    }
  }, [finder, findPasted]);
  const [editingTypesOf, setEditingTypesOf] = useState<string | null>(null);
  const [sortFrom, setSortFrom] = useState<Event | null>(null);
  const [optionsFrom, setOptionsFrom] = useState<Event | null>(null);
  const [channelMenu, setChannelMenu] = useState<{ from: Event; channel: Subscription } | null>(null);

  const subscriptions = useLiveQuery(() => db.subscriptions.toArray(), [db]);
  const secretCard = useLiveQuery(() => secretCardDue(db), [db]) ?? false;
  const sort = useLiveQuery(() => getMeta<ChannelSort>(db, 'channelSort'), [db]) ?? 'recent';
  const lastUploads = useLiveQuery(
    async () =>
      new Map(
        await Promise.all(
          (await db.subscriptions.toCollection().primaryKeys()).map(async (key) => {
            const latest = await db.items.where('[channel+published]').between([key, Dexie.minKey], [key, Dexie.maxKey]).last();

            return [key, latest?.published] as const;
          }),
        ),
      ),
    [db],
  );

  // The feed's empty state links here to add a first channel: the search field is where.
  useEffect(() => {
    if (searchParams.get('add') !== null) {
      setSearchParams({}, { replace: true });
      setTimeout(() => void searchbar.current?.setFocus(), 300);
    }
  }, [searchParams, setSearchParams]);

  // A search is the business of one visit: coming back, by the tab bar or the side menu, shows the
  // whole list again. Cleared once the screen is gone, so the list doesn't change under the eyes;
  // the field lets go of the focus as soon as the screen goes, so the keyboard closes with it.
  useIonViewWillLeave(() => void searchbar.current?.getInputElement().then((input) => input.blur()));
  useIonViewDidLeave(() => setSearch(''));

  const term = search.trim();
  const visible = (subscriptions ?? []).filter((channel) => secretsShown || !channel.secret);
  const waiting = visible.filter((channel) => channel.status === 'pending_submit').length;
  const lowered = term.toLocaleLowerCase();
  const shown = sortChannels(visible, sort).filter(
    (channel) => lowered === '' || channel.title.toLocaleLowerCase().includes(lowered) || (channel.handle ?? '').toLocaleLowerCase().includes(lowered.replace(/^@/, '')),
  );
  // Channels that no longer work come first, apart, each with what can be done about it.
  const attention = shown.filter(needsAction);
  const working = shown.filter((channel) => !needsAction(channel));
  const editingTypes = subscriptions?.find((channel) => channel.key === editingTypesOf) ?? null;

  const optionActions: MenuAction[] = secretsShown
    ? [
        { text: 'Hide secret channels', icon: eyeOffOutline, handler: toggleSecrets },
        // A lock is optional: added here or in Settings, Lock, where it is also changed or turned off.
        ...(secretLock === 'none' ? [{ text: 'Lock secret channels…', icon: lockClosedOutline, handler: () => void lockSecrets(true) }] : []),
      ]
    : [{ text: 'Show secret channels', icon: eyeOutline, handler: toggleSecrets }];

  const channelActions = (channel: Subscription): MenuAction[] => [
    { text: 'Show videos', icon: playOutline, handler: () => showVideos(channel) },
    { text: 'Kinds of videos…', icon: optionsOutline, handler: () => setEditingTypesOf(channel.key) },
    channel.secret
      ? { text: 'Stop keeping secret', icon: eyeOutline, handler: () => setChannelSecret(channel.key, false) }
      : { text: 'Make secret', icon: eyeOffOutline, handler: () => setChannelSecret(channel.key, true) },
    { text: 'Remove', icon: trashOutline, danger: true, handler: () => confirmRemove(channel) },
  ];

  // Leaving this screen hides the secret channels: a secret one opened here stays on its own.
  const showVideos = (channel: Subscription) => {
    setSecretOpened(channel.secret ? channel.key : null);
    navigate(`/feed?channel=${encodeURIComponent(channel.key)}`);
  };

  const confirmRemove = (channel: Subscription) => {
    void presentAlert({
      header: `Remove ${channel.title}?`,
      message: 'Its videos will also be removed from your feed.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Remove', role: 'destructive', handler: () => void unsubscribe(db, channel.key) },
      ],
    });
  };

  const count = visible.length;

  return (
    <Page
      title="Channels"
      subtitle={count > 0 ? `Following ${count} ${count === 1 ? 'channel' : 'channels'}` : 'Choose whose uploads appear in your feed.'}
      actions={
        <>
          {count > 1 && (
            <IonButton aria-label="Sort channels" onClick={(event) => setSortFrom(event.nativeEvent)}>
              <IonIcon slot="icon-only" icon={swapVerticalOutline} />
            </IonButton>
          )}
          {(subscriptions?.length ?? 0) > 0 && (
            <IonButton aria-label="Channel options" onClick={(event) => setOptionsFrom(event.nativeEvent)}>
              <IonIcon slot="icon-only" {...MORE_ICON} />
            </IonButton>
          )}
        </>
      }
      overlays={
        <>
          <Menu from={optionsFrom} onClose={() => setOptionsFrom(null)} actions={optionActions} />
          <Menu from={channelMenu?.from ?? null} onClose={() => setChannelMenu(null)} actions={channelMenu === null ? [] : channelActions(channelMenu.channel)} />
          <SortMenu from={sortFrom} onClose={() => setSortFrom(null)} sort={sort} onSort={(next) => void setMeta(db, 'channelSort', next)} />
          <ChannelTypesModal channel={editingTypes} onClose={() => setEditingTypesOf(null)} />
        </>
      }
    >
      <SecretsBanner />
      <SecretTour place="channels" />

      <IonSearchbar
        ref={searchbar}
        placeholder="Search or add a channel"
        aria-label="Search or add a channel"
        autocapitalize="off"
        autocorrect={false}
        spellcheck={false}
        enterkeyhint="search"
        value={search}
        onIonInput={(event) => setSearch(String(event.detail.value ?? ''))}
        // Getting ready to add a channel (D12): the list of channel names comes now, so a name finds
        // channels while it is typed, offline. Never asks: with the connection check on and nothing
        // approved yet, the first name looked up brings it.
        onIonFocus={() => void gate.whenApproved(() => refreshDictionary(db, api))}
        onKeyDown={(event) => {
          // Enter does what the list's last row does: search online.
          if (event.key === 'Enter') {
            void finder.widen();
          }
        }}
      />

      {/* From the second channel, once: the tour takes over when the first one is made secret. */}
      {secretCard && term === '' && (
        <IonCard>
          <IonCardContent>
            <strong>Keep a channel to yourself.</strong> Tap ⋯ next to it, then “Make secret”: it stays out of your feed and this list until you show it.
          </IonCardContent>
          <IonButton fill="clear" onClick={() => void dismissSecretCard(db)}>
            Got it
          </IonButton>
        </IonCard>
      )}

      {subscriptions !== undefined && count === 0 && term === '' && (
        <EmptyState icon={people} heading="No channels yet">
          Type a channel’s name or @handle above, or paste a link to it or any of its videos.
        </EmptyState>
      )}

      {term === '' && attention.length > 0 && (
        <Section heading="Need your attention">
          {attention.map((channel, index) => (
            <IonItemSliding key={channel.key}>
              <IonItem {...(index === attention.length - 1 ? { lines: 'none' as const } : {})}>
                <ChannelAvatar channel={channel.key} title={channel.title} avatar={channel.avatar} slot="start" secret={channel.secret} />
                <IonLabel>
                  {/* The avatar's ring is hidden from screen readers: the name says it instead. */}
                  <h2 {...(channel.secret ? { 'aria-label': `${channel.title}, secret` } : {})}>{channel.title}</h2>
                  <p>{channel.status === 'gone' ? 'No longer exists on YouTube' : 'Couldn’t be found online'}</p>
                </IonLabel>
                {channel.status === 'gone' ? (
                  <IonButton slot="end" size="small" color="danger" onClick={() => confirmRemove(channel)}>
                    <IonIcon slot="start" icon={trashOutline} aria-hidden="true" />
                    Remove
                  </IonButton>
                ) : (
                  <IonButton slot="end" size="small" onClick={() => void db.subscriptions.update(channel.key, { status: 'pending_submit' })}>
                    <IonIcon slot="start" icon={refreshOutline} aria-hidden="true" />
                    Try again
                  </IonButton>
                )}
              </IonItem>
              <IonItemOptions side="end">
                <IonItemOption
                  color="danger"
                  onClick={(event) => {
                    void (event.currentTarget.closest('ion-item-sliding') as HTMLIonItemSlidingElement | null)?.close();
                    confirmRemove(channel);
                  }}
                >
                  <IonIcon slot="top" icon={trashOutline} aria-hidden="true" />
                  Remove
                </IonItemOption>
              </IonItemOptions>
            </IonItemSliding>
          ))}
        </Section>
      )}

      {term === '' && working.length > 0 && (
        <Section {...(attention.length > 0 ? { heading: 'Following' } : {})} {...(waiting > 0 ? { footer: `${waiting === 1 ? '1 channel is' : `${waiting} channels are`} being added, one at a time, while the app is open.` } : {})}>
          {working.map((channel, index) => (
            // Swiping a row offers its removal, as in the platforms' own lists; the ⋯ button
            // offers it too, for mice and for those who don't know the gesture.
            <IonItemSliding key={channel.key}>
              <IonItem button detail={false} {...(index === working.length - 1 ? { lines: 'none' as const } : {})} onClick={() => showVideos(channel)}>
                <ChannelAvatar channel={channel.key} title={channel.title} avatar={channel.avatar} slot="start" secret={channel.secret} />
                <IonLabel>
                  {/* The avatar's ring is hidden from screen readers: the name says it instead. */}
                  <h2 {...(channel.secret ? { 'aria-label': `${channel.title}, secret` } : {})}>{channel.title}</h2>
                  <p className="ion-display-flex ion-align-items-center">
                    {channelStatus(channel, lastUploads?.get(channel.key))}
                    {channel.retryAt === undefined && joining(channel) ? (
                      <JoiningInfo title={channel.title} />
                    ) : (
                      channel.status !== 'pending_submit' &&
                      lastUploads?.get(channel.key) === undefined &&
                      (channel.retryAt === undefined ? <NotFetchedInfo title={channel.title} /> : <RetryInfo title={channel.title} retryAt={channel.retryAt} />)
                    )}
                  </p>
                </IonLabel>
                <IonButton
                  slot="end"
                  fill="clear"
                  color="medium"
                  aria-label={`Actions for ${channel.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setChannelMenu({ from: event.nativeEvent, channel });
                  }}
                >
                  <IonIcon slot="icon-only" {...MORE_ICON} />
                </IonButton>
              </IonItem>
              <IonItemOptions side="end">
                <IonItemOption
                  color="danger"
                  onClick={(event) => {
                    void (event.currentTarget.closest('ion-item-sliding') as HTMLIonItemSlidingElement | null)?.close();
                    confirmRemove(channel);
                  }}
                >
                  <IonIcon slot="top" icon={trashOutline} aria-hidden="true" />
                  Remove
                </IonItemOption>
              </IonItemOptions>
            </IonItemSliding>
          ))}
        </Section>
      )}

      {/* As soon as something is typed, one list replaces the page's: the followed channels it
          matches, the channels to follow, and the row that searches further. */}
      {term !== '' && (
        <ChannelSearchResults
          finder={finder}
          own={shown}
          onOpen={showVideos}
          onPaste={(link) => {
            if (link === null) {
              // The link pasted there replaces the name.
              void searchbar.current?.getInputElement().then((input) => {
                input.focus();
                input.select();
              });
            } else {
              setSearch(link);
              setFindPasted(link);
            }
          }}
        />
      )}
    </Page>
  );
}

function needsAction(channel: Subscription): boolean {
  return channel.status === 'failed' || channel.status === 'gone';
}

function channelStatus(channel: Subscription, latest: number | undefined): string {
  switch (channel.status) {
    case 'pending_submit':
      return 'Waiting to be added…';
    default:
      // A channel whose read failed says when to refresh first: that one matters more.
      if (channel.retryAt === undefined && joining(channel)) {
        return 'New videos may be late';
      }

      if (latest !== undefined) {
        return `Last upload ${ageLabel(latest)}`;
      }

      if (channel.retryAt !== undefined) {
        return refreshHint(channel.retryAt);
      }

      return 'No videos fetched';
  }
}
