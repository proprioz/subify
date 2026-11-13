import {
  IonApp,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonMenu,
  IonRouterOutlet,
  IonSplitPane,
  IonTabBar,
  IonTabButton,
  IonTabs,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import { people, peopleOutline, play, playOutline, settings, settingsOutline } from 'ionicons/icons';
import { useEffect } from 'react';
import { Navigate, Route, useLocation } from 'react-router-dom';
import { AppDataProvider, useAppData } from './app/AppData';
import { BiometricsFlowProvider } from './app/BiometricsFlow';
import { SecretFlowProvider } from './app/SecretFlow';
import { VaultGate } from './app/VaultGate';
import { TourPage } from './pages/TourPage';
import { RefreshBar } from './components/RefreshBar';
import { StorageWarning } from './components/StorageWarning';
import { ChannelsPage } from './pages/ChannelsPage';
import { FeedPage } from './pages/FeedPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { SettingsPage } from './pages/SettingsPage';
import { WhyPage } from './pages/WhyPage';
import { TAB_BAR_ID } from './ui/toast';

export function App() {
  return (
    <IonApp>
      <AppDataProvider>
        <VaultGate>
          <BiometricsFlowProvider>
            <SecretFlowProvider>
              <IonReactRouter>
                <IonSplitPane contentId="main" when="lg">
                  <SideMenu />
                  <Tabs />
                </IonSplitPane>
                <StorageWarning />
              </IonReactRouter>
              <RefreshBar />
            </SecretFlowProvider>
          </BiometricsFlowProvider>
        </VaultGate>
      </AppDataProvider>
    </IonApp>
  );
}

const TABS = [
  { tab: 'feed', label: 'Feed', icon: playOutline, selectedIcon: play },
  { tab: 'channels', label: 'Channels', icon: peopleOutline, selectedIcon: people },
  { tab: 'settings', label: 'Settings', icon: settingsOutline, selectedIcon: settings },
];

/**
 * The tabs as a side menu that stays open on wide screens, where the tab bar hides (the split
 * pane and `ion-hide-lg-up` share the same breakpoint). Narrower screens never see it: no button
 * opens it and it has no swipe gesture.
 */
function SideMenu() {
  const { pathname } = useLocation();

  return (
    <IonMenu contentId="main" swipeGesture={false}>
      <IonHeader className="ion-no-border">
        <IonToolbar>
          <IonTitle>Subify</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <IonList lines="none">
          {TABS.map(({ tab, label, icon, selectedIcon }) => {
            const selected = pathname.startsWith(`/${tab}`);

            return (
              <IonItem
                key={tab}
                routerLink={`/${tab}`}
                routerDirection="root"
                onClick={() => pathname === `/${tab}` && scrollShownPageToTop()}
                detail={false}
                aria-current={selected ? 'page' : undefined}
                {...(selected ? { color: 'light' } : {})}
              >
                <IonIcon slot="start" aria-hidden="true" icon={selected ? selectedIcon : icon} />
                <IonLabel>{label}</IonLabel>
              </IonItem>
            );
          })}
        </IonList>
      </IonContent>
    </IonMenu>
  );
}

/**
 * Scrolls the page shown back to its top, as a second tap on its tab does in both platforms' own
 * apps, and the feed's channel strip back to its start, where its tools and “All” are. Only from
 * the tab's own page: from a page below it, Ionic takes the tap back to the tab.
 */
function scrollShownPageToTop() {
  const page = document.querySelector('#main ion-router-outlet > .ion-page:not(.ion-page-hidden)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  void page?.querySelector<HTMLIonContentElement>('ion-content')?.scrollToTop(reduced ? 0 : 300);
  // At once: Safari drops a smooth scroll of the strip when the feed redraws for “All” just after.
  page?.querySelector('.channel-strip')?.scrollTo({ left: 0 });
}

/** The three tabs. The current one shows its filled icon. */
function Tabs() {
  const { pathname } = useLocation();
  const { setSecretsShown, setSecretOpened } = useAppData();

  // Secret channels show on one screen only: going to another one hides them again. A secret
  // channel opened on its own from the list stays while the feed shows it.
  useEffect(() => {
    setSecretsShown(false);

    if (pathname !== '/feed') {
      setSecretOpened(null);
    }
  }, [pathname, setSecretsShown, setSecretOpened]);

  return (
    // The split pane's main content needs an id, which IonTabs does not take.
    <div id="main" className="ion-page">
      <IonTabs>
        <IonRouterOutlet>
          <Route path="/feed" element={<FeedPage />} />
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/privacy" element={<PrivacyPage />} />
          <Route path="/settings/why" element={<WhyPage />} />
          <Route path="/settings/tour" element={<TourPage />} />
          <Route path="/" element={<Navigate to="/feed" replace />} />
        </IonRouterOutlet>

        <IonTabBar slot="bottom" id={TAB_BAR_ID} className="ion-hide-lg-up" translucent>
          {TABS.map(({ tab, label, icon, selectedIcon }) => (
            <IonTabButton key={tab} tab={tab} href={`/${tab}`} onClick={() => pathname === `/${tab}` && scrollShownPageToTop()}>
              <IonIcon aria-hidden="true" icon={pathname.startsWith(`/${tab}`) ? selectedIcon : icon} />
              <IonLabel>{label}</IonLabel>
            </IonTabButton>
          ))}
        </IonTabBar>
      </IonTabs>
    </div>
  );
}
