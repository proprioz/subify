import { getConfig, IonBackButton, IonButtons, IonCol, IonContent, IonFab, IonGrid, IonHeader, IonNote, IonPage, IonRow, IonTitle, IonToolbar } from '@ionic/react';
import { type ReactNode, useRef, useState } from 'react';
import { useWideScreen } from '../ui/wide-screen';

interface Props {
  title: string;
  subtitle?: ReactNode;
  /** The page's buttons: in its toolbar, or beside the title on wide screens. */
  actions?: ReactNode;
  /**
   * Controls under the title, such as the feed's channel strip. On iOS phones they stay at the top
   * of the screen in place of the toolbar, and the title scrolls away.
   */
  bar?: ReactNode;
  /** Where the back button leads when there is no history, for pages below a tab. */
  back?: string;
  /** Something before the content scrolls, such as an IonRefresher (slot="fixed"). */
  fixed?: ReactNode;
  /**
   * A floating action button at the bottom right, such as the feed's refresh button. It moves out
   * of the way while the user scrolls down, and comes back as soon as they scroll up.
   */
  fab?: ReactNode;
  /** Overlays that belong to the page: popovers and modals. */
  overlays?: ReactNode;
  /** Uses the full width of large screens, for the feed's grid, instead of a reading column. */
  wide?: boolean;
  /**
   * While true, an action icon with the `refresh-icon` class turns. The loading bar itself is the
   * app's, at the top of the screen (RefreshBar).
   */
  refreshing?: boolean;
  children: ReactNode;
}

/**
 * A page, headed by a large title on the left with a subtitle under it and the
 * page's buttons beside it.
 *
 * On phones and tablets it is Ionic's collapsible large title, which condenses into the usual
 * small toolbar on scroll; the buttons stay in that toolbar, above the large title. A page with a
 * bar has no small toolbar there: the bar sticks to the top instead, so its button goes in `fab`
 * rather than `actions`, which would not show on iOS phones. That title
 * only exists in iOS mode: elsewhere the toolbar alone heads the page, and the subtitle needs its
 * own space below it. On wide screens the toolbar would run across the whole window, far from a
 * centred column, so the title sits at the top of the column instead, in Ionic's own heading type.
 */
export function Page({ title, subtitle, actions, bar, back, fixed, fab, overlays, wide = false, refreshing = false, children }: Props) {
  const wideScreen = useWideScreen();
  const [fabHidden, setFabHidden] = useState(false);
  // Where the content stood the last time the button's state was decided: a scroll counts only
  // once it has moved far enough from there, so a finger's small jitter does not flicker it.
  const scrolledFrom = useRef(0);
  const ios = getConfig()?.get('mode') === 'ios';
  const hasSubtitle = subtitle !== undefined && subtitle !== null;
  // A small toolbar over the bar would only repeat the title: the bar heads the page instead.
  const barOnTop = ios && !wideScreen && bar !== undefined;
  // Without a header to make room for the status bar, the content does (theme.css).
  const headerless = barOnTop || wideScreen;
  const backButton = back !== undefined && (
    <IonButtons slot="start">
      <IonBackButton defaultHref={back} />
    </IonButtons>
  );

  return (
    <IonPage className={refreshing ? 'refreshing' : ''}>
      {!barOnTop && (
        <IonHeader translucent className="ion-hide-lg-up">
          <IonToolbar>
            {backButton}
            <IonTitle>{title}</IonTitle>
            {actions !== undefined && <IonButtons slot="end">{actions}</IonButtons>}
          </IonToolbar>
        </IonHeader>
      )}
      <IonContent
        className={headerless ? 'headerless' : undefined}
        fullscreen
        scrollEvents={fab !== undefined}
        onIonScroll={(event) => {
          const top = event.detail.scrollTop;

          if (Math.abs(top - scrolledFrom.current) >= FAB_SCROLL_STEP) {
            // Near the top it always shows, also while iOS's bounce pulls the content back down.
            setFabHidden(top > scrolledFrom.current && top > FAB_SCROLL_STEP * 4);
            scrolledFrom.current = top;
          }
        }}
      >
        {headerless && <div slot="fixed" className="status-backdrop" />}
        {fixed}
        {fab !== undefined && (
          <IonFab slot="fixed" vertical="bottom" horizontal="end" className={fabHidden ? 'fab-hidden' : ''}>
            {fab}
          </IonFab>
        )}
        <Column wide={wide}>
          {wideScreen ? (
            <div className="page-title ion-display-flex ion-align-items-center ion-padding-horizontal">
              {backButton}
              <h1 className="ion-flex-1">{title}</h1>
              {actions !== undefined && <IonButtons>{actions}</IonButtons>}
            </div>
          ) : (
            // The buttons sit in the small toolbar above (or the bar), as in iOS's own apps,
            // rather than beside the large title. The subtitle is a toolbar of the large title's header: it slides
            // under the large title as it scrolls away, instead of under the small title.
            <IonHeader collapse="condense">
              <IonToolbar>
                <IonTitle size="large">{title}</IonTitle>
              </IonToolbar>
              {ios && hasSubtitle && (
                <IonToolbar className="page-subtitle">
                  <IonNote color="medium" className="ion-display-block ion-padding-horizontal">
                    {subtitle}
                  </IonNote>
                </IonToolbar>
              )}
            </IonHeader>
          )}
          {(wideScreen || !ios) && hasSubtitle && (
            <IonNote color="medium" className={`ion-display-block ion-padding-horizontal${wideScreen ? '' : ' ion-padding-top'}`}>
              {subtitle}
            </IonNote>
          )}
          {barOnTop ? (
            <div className="page-bar">{bar}</div>
          ) : (
            bar
          )}
          {children}
        </Column>
      </IonContent>
      {overlays}
    </IonPage>
  );
}

/** How far, in pixels, the content scrolls before the floating button hides or shows again. */
const FAB_SCROLL_STEP = 16;

/**
 * Keeps a page's content at a readable width on large screens. Phones and tablets keep the full
 * width: Ionic's fixed grid only starts capping it at `lg` (see `--ion-grid-width-*` in
 * theme.css), and the column narrows further unless the page is `wide`.
 */
export function Column({ wide = false, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <IonGrid fixed className="ion-no-padding">
      <IonRow className="ion-justify-content-center">
        <IonCol size="12" sizeLg={wide ? '12' : '10'} sizeXl={wide ? '12' : '8'} className="ion-no-padding">
          {children}
        </IonCol>
      </IonRow>
    </IonGrid>
  );
}
