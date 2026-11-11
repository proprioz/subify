import { IonButton, IonIcon } from '@ionic/react';
import { logoGithub } from 'ionicons/icons';
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
          <li>What’s on your device is encrypted, and can be locked with Face ID, a fingerprint or a password.</li>
        </ul>

        <h2>No account, no tracking</h2>
        <ul>
          <li>Never a mandatory sign-in: no account, no email, no profile.</li>
          <li>The platform never learns which channels you follow, and neither does Subify’s server.</li>
          <li>No ads, and nothing that studies your habits.</li>
          <li>The app never goes online on its own: only for what you are doing in it, and without sending anything that identifies you.</li>
          <li>
            <Link to="/settings/privacy">Privacy</Link> says exactly who sees what.
          </li>
        </ul>

        <h2>Open source</h2>
        <p>You don’t have to trust us. Subify’s code is public, under a free license: anyone can check it, and run their own server.</p>
        <IonButton expand="block" href="https://github.com/proprioz/subify" target="_blank" rel="noopener noreferrer">
          <IonIcon slot="start" icon={logoGithub} aria-hidden="true" />
          See the code on GitHub
        </IonButton>

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
