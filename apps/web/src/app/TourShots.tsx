import { IonIcon } from '@ionic/react';
import { checkmark, eyeOffOutline, people, peopleOutline, play, playOutline, refreshOutline, searchOutline, settings, settingsOutline, syncOutline } from 'ionicons/icons';
import type { CSSProperties, ReactNode } from 'react';

/**
 * The tour's pictures: small screens of the app, drawn here rather than captured, so they stay
 * sharp and weigh nothing. Each one is simplified, on an iPhone or an Android device, light or dark,
 * with tooltips over it. The channels are real ones, shown by their initials: no one else's
 * images are copied. The pictures are decoration: the tour's text says the same.
 */

interface Tip {
  text: string;
  /** Where the tip sits over the device, in % of its size. */
  at: CSSProperties;
  /** Which way its arrow points. */
  arrow: 'up' | 'down';
}

const CHANNELS = {
  nasa: { title: 'NASA', initials: 'N', colour: '#0b3d91' },
  kurzgesagt: { title: 'Kurzgesagt – In a Nutshell', initials: 'K', colour: '#e8663d' },
  veritasium: { title: 'Veritasium', initials: 'V', colour: '#b71c1c' },
  tomScott: { title: 'Tom Scott', initials: 'TS', colour: '#2e7d32' },
};

type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

function Device({ os, dark, tips, children }: { os: 'ios' | 'android'; dark: boolean; tips: Tip[]; children: ReactNode }) {
  return (
    <div className="shot-stage" aria-hidden="true">
      <div className={`shot shot-${os}${dark ? ' shot-dark' : ''}`}>
        <div className="shot-status">
          <span>{os === 'ios' ? '9:41' : '12:30'}</span>
          <span className="shot-camera" />
          <span className="shot-battery" />
        </div>
        {children}
        <span className="shot-home" />
      </div>
      {tips.map((tip) => (
        <div key={tip.text} className={`shot-tip shot-tip-${tip.arrow}`} style={tip.at}>
          {tip.text}
        </div>
      ))}
    </div>
  );
}

function Avatar({ channel, secret = false }: { channel: Channel; secret?: boolean }) {
  return (
    <span className="shot-avatar" style={{ background: channel.colour }}>
      {channel.initials}
      {secret && <IonIcon icon={eyeOffOutline} className="shot-secret" />}
    </span>
  );
}

function Row({ channel, note, end, secret }: { channel: Channel; note: string; end?: ReactNode; secret?: boolean }) {
  return (
    <div className="shot-row">
      <Avatar channel={channel} secret={secret ?? false} />
      <span className="shot-row-text">
        <b>{channel.title}</b>
        <small>{note}</small>
      </span>
      {end}
    </div>
  );
}

function Video({ channel, title, kind, age, thumbnail }: { channel: Channel; title: string; kind: string; age: string; thumbnail: string }) {
  return (
    <div className="shot-video">
      <span className="shot-thumbnail" style={{ background: thumbnail }} />
      <span className="shot-row-text">
        <b>{title}</b>
        <small>
          <span className="shot-kind">{kind}</span> {channel.title} · {age}
        </small>
      </span>
    </div>
  );
}

function Tabs({ on }: { on: 'feed' | 'channels' | 'settings' }) {
  const tabs = [
    { tab: 'feed', label: 'Feed', icon: playOutline, selected: play },
    { tab: 'channels', label: 'Channels', icon: peopleOutline, selected: people },
    { tab: 'settings', label: 'Settings', icon: settingsOutline, selected: settings },
  ] as const;

  return (
    <div className="shot-tabs">
      {tabs.map(({ tab, label, icon, selected }) => (
        <span key={tab} className={tab === on ? 'shot-tab-on' : ''}>
          <IonIcon icon={tab === on ? selected : icon} />
          {label}
        </span>
      ))}
    </div>
  );
}

/** Adding a channel: its name in the search field, on an iPhone in light mode. */
export function AddShot() {
  return (
    <Device os="ios" dark={false} tips={[{ text: 'Type a name, @handle or link', at: { top: '32.5%', left: '-6%' }, arrow: 'up' }]}>
      <div className="shot-large-title">Channels</div>
      <div className="shot-search">
        <IonIcon icon={searchOutline} />
        veritasium<span className="shot-caret" />
      </div>
      <div className="shot-list">
        <Row channel={CHANNELS.veritasium} note="@veritasium" end={<span className="shot-pill">Add</span>} />
      </div>
      <div className="shot-heading">Your channels</div>
      <div className="shot-list">
        <Row channel={CHANNELS.nasa} note="Videos, Shorts, Lives" />
        <Row channel={CHANNELS.kurzgesagt} note="Videos" />
        <Row channel={CHANNELS.tomScott} note="Videos, Shorts" />
      </div>
      <Tabs on="channels" />
    </Device>
  );
}

/** The feed, pulled down to refresh, on an Android device in dark mode. */
export function RefreshShot() {
  return (
    <Device os="android" dark tips={[{ text: 'Pull down, or tap refresh', at: { top: '24%', right: '-6%' }, arrow: 'up' }]}>
      <div className="shot-toolbar">Feed</div>
      <div className="shot-spinner">
        <IonIcon icon={refreshOutline} />
      </div>
      <Video channel={CHANNELS.kurzgesagt} title="What if the Moon went dark?" kind="V" age="2h" thumbnail="linear-gradient(135deg, #f7b733, #fc4a1a)" />
      <Video channel={CHANNELS.nasa} title="Live: a rocket on the pad" kind="L" age="5h" thumbnail="linear-gradient(135deg, #1e3c72, #2a5298)" />
      <Video channel={CHANNELS.veritasium} title="The odd physics of a falling slinky" kind="V" age="1d" thumbnail="linear-gradient(135deg, #43cea2, #185a9d)" />
      <Video channel={CHANNELS.tomScott} title="A town that moved one metre" kind="S" age="2d" thumbnail="linear-gradient(135deg, #8e9eab, #4b6cb7)" />
      <span className="shot-fab">
        <IonIcon icon={syncOutline} />
      </span>
      <Tabs on="feed" />
    </Device>
  );
}

/** A channel's kinds of videos, and a secret channel, on an iPhone in dark mode. */
export function ChooseShot() {
  const check = (on: boolean) => <span className={on ? 'shot-check shot-check-on' : 'shot-check'}>{on && <IonIcon icon={checkmark} />}</span>;

  return (
    <Device
      os="ios"
      dark
      tips={[
        { text: 'Secret channels stay hidden', at: { top: '33%', left: '-6%' }, arrow: 'up' },
        { text: 'Videos, Shorts or lives: you pick', at: { top: '49%', right: '-8%' }, arrow: 'down' },
      ]}
    >
      <div className="shot-large-title">Channels</div>
      <div className="shot-list">
        <Row channel={CHANNELS.nasa} note="Videos, Shorts, Lives" />
        <Row channel={CHANNELS.tomScott} note="Secret" secret />
        <Row channel={CHANNELS.veritasium} note="Videos" />
      </div>
      <div className="shot-sheet">
        <div className="shot-sheet-bar">
          <b>Kurzgesagt</b>
          <span>Done</span>
        </div>
        <div className="shot-list">
          <div className="shot-row">Videos{check(true)}</div>
          <div className="shot-row">Shorts{check(false)}</div>
          <div className="shot-row">Lives{check(true)}</div>
        </div>
      </div>
    </Device>
  );
}

/** Settings, with the backup, on an Android device in light mode. */
export function BackupShot() {
  return (
    <Device os="android" dark={false} tips={[{ text: 'Save one now and then', at: { top: '24%', right: '-6%' }, arrow: 'down' }]}>
      <div className="shot-toolbar">Settings</div>
      <div className="shot-heading">Lock</div>
      <div className="shot-list">
        <div className="shot-row">
          <span className="shot-row-text">
            <b>Ask to unlock</b>
            <small>Each time the app opens</small>
          </span>
        </div>
      </div>
      <div className="shot-heading">Backup</div>
      <div className="shot-list">
        <div className="shot-row">
          <span className="shot-row-text">
            <b>Save a backup</b>
            <small>Last saved 3 days ago</small>
          </span>
        </div>
        <div className="shot-row">
          <span className="shot-row-text">
            <b>Restore a backup</b>
          </span>
        </div>
      </div>
      <p className="shot-note">Your channels live only on this device. A backup holds them, locked with a password.</p>
      <Tabs on="settings" />
    </Device>
  );
}
