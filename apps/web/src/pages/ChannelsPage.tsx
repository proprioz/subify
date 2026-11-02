import {
  IonButton,
  IonIcon,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonLabel,
  IonNote,
  IonSearchbar,
  useIonAlert,
} from '@ionic/react';
import Dexie from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  eyeOffOutline,
  eyeOutline,
  fingerPrintOutline,
  keyOutline,
  optionsOutline,
  people,
  playOutline,
  refreshOutline,
  swapVerticalOutline,
  trashOutline,
} from 'ionicons/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { useSecretFlow } from '../app/SecretFlow';
import { ChannelAvatar } from '../components/ChannelAvatar';
import { ChannelTypesModal } from '../components/ChannelTypesModal';
import { EmptyState } from '../components/EmptyState';
import { channelLink, FindChannelModal, LookUpButton, NameMatches, useChannelFinder } from '../components/FindChannelModal';
import { Menu, type MenuAction } from '../components/Menu';
import { Page } from '../components/Page';
import { SecretsBanner } from '../components/SecretsBanner';
import { Section } from '../components/Section';
import { SortMenu } from '../components/SortMenu';
import { isChannelInput, isChannelName } from '../data/channel-link';
import { getMeta, setMeta, type Subscription } from '../data/db';
import { type ChannelSort, sortChannels } from '../data/feed';
import { ageLabel } from '../data/format';
import { unsubscribe } from '../data/subscriptions';
import { MORE_ICON } from '../ui/icons';

export function ChannelsPage() {
  const { db, secretsShown, setSecretsShown, setSecretOpened } = useAppData();
  const { toggleSecrets, setChannelSecret, changeCode, biometrics, turnOnBiometrics } = useSecretFlow();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [presentAlert] = useIonAlert();
  const searchbar = useRef<HTMLIonSearchbarElement>(null);
  const [search, setSearch] = useState('');
  // Closing the results clears the field: what was typed there has been dealt with.
  const finder = useChannelFinder(useCallback(() => setSearch(''), []));
  const [editingTypesOf, setEditingTypesOf] = useState<string | null>(null);
  const [sortFrom, setSortFrom] = useState<Event | null>(null);
  const [optionsFrom, setOptionsFrom] = useState<Event | null>(null);
  const [channelMenu, setChannelMenu] = useState<{ from: Event; channel: Subscription } | null>(null);

  const subscriptions = useLiveQuery(() => db.subscriptions.toArray(), [db]);
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

  const term = search.trim();
  const explicit = isChannelInput(term);
  const addable = explicit || isChannelName(term);
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
        { text: 'Change secret code', icon: keyOutline, handler: changeCode },
        ...(biometrics === 'on'
          ? [{ text: 'Turn off Face ID or fingerprint', icon: fingerPrintOutline, handler: () => void db.meta.delete('secretCredential').then(() => setSecretsShown(false)) }]
          : biometrics === 'off'
            ? [{ text: 'Turn on Face ID or fingerprint', icon: fingerPrintOutline, handler: turnOnBiometrics }]
            : []),
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
          <FindChannelModal finder={finder} />
        </>
      }
    >
      <SecretsBanner />

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
        onKeyDown={(event) => {
          // A name searches the list too: only its button sends it online.
          if (event.key === 'Enter' && explicit) {
            void finder.lookUp(term);
          }
        }}
      />

      {subscriptions !== undefined && count === 0 && term === '' && (
        <EmptyState icon={people} heading="No channels yet">
          Type a channel’s name or @handle above, or paste a link to it or any of its videos.
        </EmptyState>
      )}

      {count > 0 && shown.length === 0 && !explicit && (
        <IonNote color="medium" className="ion-display-block ion-padding ion-text-center">
          {addable ? 'No channels match that search.' : 'No channels match that search. To add one, type its name or paste its link.'}
        </IonNote>
      )}

      {attention.length > 0 && (
        <Section heading="Need your attention">
          {attention.map((channel, index) => (
            <IonItemSliding key={channel.key}>
              <IonItem {...(index === attention.length - 1 ? { lines: 'none' as const } : {})}>
                <ChannelAvatar title={channel.title} avatar={channel.avatar} slot="start" />
                <IonLabel>
                  <h2>
                    {channel.secret && <IonIcon icon={eyeOffOutline} className="secret-mark" aria-label="Secret" />}
                    {channel.title}
                  </h2>
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

      {working.length > 0 && (
        <Section {...(attention.length > 0 ? { heading: 'Following' } : {})} {...(waiting > 0 ? { footer: `${waiting === 1 ? '1 channel is' : `${waiting} channels are`} being added, one at a time, while the app is open.` } : {})}>
          {working.map((channel, index) => (
            // Swiping a row offers its removal, as in the platforms' own lists; the ⋯ button
            // offers it too, for mice and for those who don't know the gesture.
            <IonItemSliding key={channel.key}>
              <IonItem button detail={false} {...(index === working.length - 1 ? { lines: 'none' as const } : {})} onClick={() => showVideos(channel)}>
                <ChannelAvatar title={channel.title} avatar={channel.avatar} slot="start" secret={channel.secret} />
                <IonLabel>
                  <h2>
                    {channel.secret && <IonIcon icon={eyeOffOutline} className="secret-mark" aria-label="Secret" />}
                    {channel.title}
                  </h2>
                  <p>{channelStatus(channel, lastUploads?.get(channel.key))}</p>
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

      {/* Below the channels the text matched: a handle may name one already followed. */}
      {addable && (
        <div className="ion-padding-horizontal">
          <LookUpButton text={term} disabled={finder.finding !== null} onClick={() => void finder.lookUp(term)} />
        </div>
      )}

      {/* Once the device has the dictionary, a name finds channels while it is typed, offline. */}
      {addable && <NameMatches text={term} onPick={(channel) => void finder.lookUp(channelLink(channel))} />}
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
      return latest === undefined ? 'No uploads yet' : `Last upload ${ageLabel(latest)}`;
  }
}
