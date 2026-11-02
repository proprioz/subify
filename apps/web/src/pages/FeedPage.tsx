import {
  IonButton,
  IonCard,
  IonCardContent,
  IonCol,
  IonFabButton,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonListHeader,
  IonNote,
  IonRefresher,
  IonRefresherContent,
  IonRow,
  IonSearchbar,
  IonText,
} from '@ionic/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { add, play, refreshOutline, searchOutline, syncOutline } from 'ionicons/icons';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { useSecretFlow } from '../app/SecretFlow';
import { ChannelStrip } from '../components/ChannelStrip';
import { EmptyState } from '../components/EmptyState';
import { useInstallFlow } from '../components/InstallGuide';
import { Page } from '../components/Page';
import { SecretsBanner } from '../components/SecretsBanner';
import { VideoCard } from '../components/VideoCard';
import { ALL_TYPES, getMeta, setMeta } from '../data/db';
import {
  type ChannelSort,
  DEFAULT_SHOW_UPCOMING,
  DEFAULT_TYPE_FILTER,
  type FeedEntry,
  loadFeed,
  loadShowUpcoming,
  loadTypeFilter,
  sortChannels,
  toggleType,
} from '../data/feed';
import { periodLabel, updatedLabel } from '../data/format';
import { dismissInstallCard, installCardCanStop, installCardDue, loadInstallCard } from '../data/settings';
import { canInstall, startsEmptyOnceInstalled } from '../ui/install';
import { useWideScreen } from '../ui/wide-screen';

const PAGE = 15;

export function FeedPage() {
  const { db, sync, syncing, syncError, secretsShown, secretOpened, install } = useAppData();
  const { toggleSecrets } = useSecretFlow();
  const installCard = useLiveQuery(() => loadInstallCard(db), [db]);
  const navigate = useNavigate();
  const installFlow = useInstallFlow(() => navigate('/settings?backup=1'));
  const twoColumns = useWideScreen('xl');
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedChannel = searchParams.get('channel');
  const [search, setSearch] = useState('');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const typeFilter = useLiveQuery(() => loadTypeFilter(db), [db]) ?? DEFAULT_TYPE_FILTER;
  const showUpcoming = useLiveQuery(() => loadShowUpcoming(db), [db]) ?? DEFAULT_SHOW_UPCOMING;
  const subscriptions = useLiveQuery(() => db.subscriptions.toArray(), [db]);
  const sort = useLiveQuery(() => getMeta<ChannelSort>(db, 'channelSort'), [db]) ?? 'recent';
  const lastSyncAt = useLiveQuery(() => getMeta<number>(db, 'lastSyncAt'), [db]);
  // A secret channel opened on its own shows alone: the channel filter keeps the others out.
  const opened = requestedChannel !== null && requestedChannel === secretOpened;
  const visibleChannels = sortChannels(
    (subscriptions ?? []).filter((channel) => secretsShown || !channel.secret || (opened && channel.key === requestedChannel)),
    sort,
  );
  const selectedChannel = visibleChannels.find((channel) => channel.key === requestedChannel);
  // A secret channel hidden again leaves the whole feed in its place, rather than an empty one.
  const channelKey = subscriptions === undefined || selectedChannel !== undefined ? requestedChannel : null;
  const feed = useLiveQuery(
    () => loadFeed(db, { types: typeFilter, showUpcoming, showSecret: secretsShown || opened, channel: channelKey, search, limit }),
    [db, typeFilter, showUpcoming, secretsShown, opened, channelKey, search, limit],
  );

  useEffect(() => setLimit(PAGE), [channelKey, search, typeFilter, showUpcoming]);

  // A hidden field must not keep filtering the feed: closing the search, or the options it sits
  // under, empties it.
  const closeSearch = () => {
    setSearching(false);
    setSearch('');
  };

  const showChannel = (key: string | null) => setSearchParams(key === null ? {} : { channel: key });
  const hasChannels = (subscriptions?.length ?? 0) > 0;
  const term = search.trim();
  const subtitle = !hasChannels ? (
    'Latest uploads from your channels, newest first.'
  ) : syncing ? (
    'Looking for new videos…'
  ) : syncError !== null ? (
    <IonText color="danger">{syncError}</IonText>
  ) : (
    (updatedLabel(lastSyncAt) ?? 'Latest uploads, newest first')
  );

  // The icon itself turns while the loading bar shows (see Page). The button stays
  // enabled, at full opacity: a tap then only joins the sync already running.
  const refreshButton = hasChannels ? (
    <IonFabButton color="red" aria-label={syncing ? 'Refreshing feed' : 'Refresh'} onClick={() => void sync()}>
      <IonIcon icon={syncOutline} className="refresh-icon" />
    </IonFabButton>
  ) : undefined;

  return (
    <Page
      wide
      title="Feed"
      subtitle={subtitle}
      refreshing={syncing && hasChannels}
      fab={refreshButton}
      overlays={installFlow.guide}
      bar={
        hasChannels ? (
          <ChannelStrip
            channels={visibleChannels}
            selected={channelKey}
            onSelect={showChannel}
            onToggleSecrets={toggleSecrets}
            optionsOpen={optionsOpen}
            onOptionsOpen={(open) => {
              setOptionsOpen(open);

              if (!open) {
                closeSearch();
              }
            }}
            searching={searching}
            onToggleSearch={() => (searching ? closeSearch() : setSearching(true))}
            typeFilter={typeFilter}
            onToggleType={(type) => void setMeta(db, 'typeFilter', toggleType(typeFilter, type))}
            showUpcoming={showUpcoming}
            onToggleUpcoming={() => void setMeta(db, 'showUpcoming', !showUpcoming)}
            narrowed={showUpcoming !== DEFAULT_SHOW_UPCOMING || ALL_TYPES.some((type) => typeFilter[type] !== DEFAULT_TYPE_FILTER[type])}
            sort={sort}
            onSort={(next) => void setMeta(db, 'channelSort', next)}
          />
        ) : undefined
      }
      fixed={
        <IonRefresher
          slot="fixed"
          disabled={!hasChannels}
          onIonRefresh={(event) => {
            void sync().finally(() => event.detail.complete());
          }}
        >
          <IonRefresherContent />
        </IonRefresher>
      }
    >
      <SecretsBanner opened={opened} />

      {hasChannels && searching && (
        <IonSearchbar
          placeholder={(subscriptions?.length ?? 0) > 1 ? 'Search videos and channels' : 'Search videos'}
          debounce={200}
          value={search}
          onIonInput={(event) => setSearch(String(event.detail.value ?? ''))}
        />
      )}

      {/* Once there is something to keep: an empty feed offers to install in its empty state. The
          card waits for the user's last answer to be read rather than flash. */}
      {hasChannels && canInstall(install) && installCard !== undefined && installCardDue(installCard, Date.now()) && (
        <IonCard>
          <IonCardContent>
            <strong>Install the app.</strong> It opens full screen, and the browser is less likely to clear your channels.
          </IonCardContent>
          <IonButton fill="clear" onClick={installFlow.start}>
            {install === 'prompt' ? 'Install' : 'Show me how'}
          </IonButton>
          <IonButton fill="clear" color="medium" onClick={() => void dismissInstallCard(db, Date.now(), false)}>
            Not now
          </IonButton>
          {installCardCanStop(installCard) && (
            <IonButton fill="clear" color="medium" onClick={() => void dismissInstallCard(db, Date.now(), true)}>
              Don’t show again
            </IonButton>
          )}
        </IonCard>
      )}

      {subscriptions !== undefined && !hasChannels && (
        <EmptyState
          icon={play}
          heading="Your videos will show up here"
          actions={
            <>
              <IonButton onClick={() => navigate('/channels?add=1')}>
                <IonIcon slot="start" icon={add} />
                Add a channel
              </IonButton>
              <IonButton fill="clear" size="small" onClick={() => navigate('/settings')}>
                Restore a backup
              </IonButton>
              {/* On iOS the installed app keeps its own channels: better to install before adding any. */}
              {canInstall(install) && (
                <IonButton fill="clear" size="small" onClick={installFlow.start}>
                  {install !== 'prompt' && startsEmptyOnceInstalled(install) ? 'Install the app first' : 'Install the app'}
                </IonButton>
              )}
            </>
          }
        >
          Follow a channel and its latest uploads appear here. No account, no recommendations.
        </EmptyState>
      )}

      {hasChannels && feed?.entries.length === 0 && term !== '' && (
        <EmptyState
          icon={searchOutline}
          heading={`No videos match “${term}”`}
          actions={
            <IonButton size="small" color="light" onClick={() => setSearch('')}>
              Clear search
            </IonButton>
          }
        >
          Search looks at the titles and channels of the videos in your feed{selectedChannel === undefined ? '' : ` from ${selectedChannel.title}`}.
        </EmptyState>
      )}

      {hasChannels && feed?.entries.length === 0 && term === '' && (
        <EmptyState icon={refreshOutline} heading={selectedChannel === undefined ? 'Nothing here yet' : `No videos from ${selectedChannel.title}`}>
          Refresh, or show more kinds of videos under Options.
        </EmptyState>
      )}

      {feed !== undefined &&
        groupByPeriod(feed.entries).map(([period, entries]) => {
          const cards = entries.map((entry) => (
            <VideoCard
              key={entry.item.key}
              item={entry.item}
              channel={entry.channel}
              thumbnail={entry.thumbnail}
              onShowChannel={visibleChannels.length > 1 && entry.channel.key !== channelKey ? showChannel : undefined}
            />
          ));

          // One column on phones and tablets, where the cards follow each other so that their
          // margins collapse into Ionic's spacing; two side by side on wide screens.
          return (
            <section key={period}>
              <IonListHeader>{period}</IonListHeader>
              {twoColumns ? (
                <IonRow className="feed-row">
                  {cards.map((card) => (
                    <IonCol key={card.key} size="6" className="ion-no-padding">
                      {card}
                    </IonCol>
                  ))}
                </IonRow>
              ) : (
                cards
              )}
            </section>
          );
        })}

      <IonInfiniteScroll
        disabled={!(feed?.hasMore ?? false)}
        onIonInfinite={(event) => {
          setLimit((current) => current + PAGE);
          void event.target.complete();
        }}
      >
        <IonInfiniteScrollContent />
      </IonInfiniteScroll>

      {feed?.hasMore === false && feed.entries.length > 0 && (
        <IonNote color="medium" className="ion-display-block ion-padding ion-text-center">
          Older videos are not kept by the server after six months.
        </IonNote>
      )}
    </Page>
  );
}

function groupByPeriod(entries: readonly FeedEntry[]): [string, FeedEntry[]][] {
  const groups: [string, FeedEntry[]][] = [];
  const now = Date.now();

  for (const entry of entries) {
    const period = entry.item.upcoming === 1 ? 'Upcoming' : periodLabel(entry.item.published, now);
    const last = groups.at(-1);

    if (last?.[0] === period) {
      last[1].push(entry);
    } else {
      groups.push([period, [entry]]);
    }
  }

  return groups;
}
