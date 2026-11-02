import { Link } from 'react-router-dom';
import { Page } from '../components/Page';

/** What Subify is good for, said plainly. Only claim what the app does today. */
export function WhyPage() {
  return (
    <Page title="Why Subify" back="/settings">
      <div className="ion-padding">
        <p>Subify shows the latest videos of the channels you chose, in the order they came out. That’s all it does, on purpose.</p>

        <h2>Only what you chose</h2>
        <ul>
          <li>No trending page, no recommendations: nothing you didn’t ask for.</li>
          <li>For each channel, choose what you want to see: its videos, its Shorts, its lives.</li>
          <li>Keep some channels secret: they stay hidden until you unlock them.</li>
          <li>What’s on your device is encrypted with your password.</li>
        </ul>

        <h2>No account, no tracking</h2>
        <ul>
          <li>Never a mandatory sign-in: no account, no email, no profile.</li>
          <li>The platform never learns which channels you follow.</li>
          <li>No ads, and nothing that studies your habits.</li>
          <li>The app goes online only when you ask it to.</li>
          <li>
            <Link to="/settings/privacy">Privacy</Link> says exactly who sees what.
          </li>
        </ul>

        <h2>Sealring</h2>
        <p>
          Sealring is the privacy system designed for Subify. Its name comes from the seal ring once used to close letters with wax: whoever carried the letter couldn’t read
          it without breaking the seal. Here, the server carries your news without being able to read it, and without knowing who it is for.
        </p>
        <ul>
          <li>
            <strong>Sealed.</strong> Each channel stays sealed at all times, and the server can’t open it. Every few minutes, each seal is swapped for a fresh one, so
            even copies of its data taken at different times tell nothing about the channels.
          </li>
          <li>
            <strong>The ring.</strong> If the server sent each device its own news, it would know what each device follows. So it posts everyone’s news on a ring
            (a circle) of places, like the hand of a clock going round: every few minutes it fills the next place with a bundle of sealed envelopes, always the same size, real news
            mixed with empty ones. Once round, each new bundle replaces the oldest, so the ring never grows and gives nothing away. Your device picks up the bundles it
            missed and opens only the envelopes meant for it.
          </li>
          <li>Your device finds your channels without telling the server which ones they are.</li>
          <li>
            The server can also add channels on its own, at random, the way a real person would. Whoever runs the server can’t tell which channels were added by users.
          </li>
        </ul>

        <h2>Open source</h2>
        <p>
          You don’t have to trust us. Subify’s code is public, under a free license (AGPL-3.0): anyone can audit it, and run the whole system on their own server, a Raspberry Pi, or a
          NAS (coming soon).
        </p>

        <h2>Watch on YouTube</h2>
        <p>Subify doesn’t play videos: tap a video to copy its link, or open it in YouTube and watch it there, as usual.</p>

        <h2>Support the creators you love</h2>
        <p>
          Subify shows no ads, so creators earn nothing from your visits here. Share their videos, support them directly through memberships or donations, or buy their merch.
        </p>
      </div>
    </Page>
  );
}
