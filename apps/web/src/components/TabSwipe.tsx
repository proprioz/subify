import { IonTabsContext } from '@ionic/react';
import { type RefObject, useContext, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

interface Props {
  /** The element that holds the tabs' router outlet and their bar. */
  container: RefObject<HTMLElement | null>;
  /** The tabs, from left to right. */
  tabs: readonly string[];
}

/**
 * Swiping sideways on a tab's screen moves to the tab beside it, as a pager does: the screen
 * follows the finger with its neighbour next to it, and a flick is enough. Past the first and the
 * last tab, the screen still moves a little under the finger, slower and slower, and springs back.
 *
 * Touch only, and only on a tab's own screen: a page below it (Privacy) keeps the platform's swipe
 * back. What moves sideways by itself keeps its swipe: the channel strip, segments, toggles, and a
 * row's options, in the direction that opens them. The tab changes through the tab bar's own
 * selection, so it is the same as tapping it, each tab coming back to the page it was on.
 *
 * Ionic keeps a tab's page in the DOM once visited, hidden: the swipe shows it beside the current
 * one for as long as it lasts (`tab-swipe-peek` in theme.css), and lets Ionic swap them at the end.
 * A tab not visited yet has no page: it slides in as soon as Ionic adds it.
 */
export function TabSwipe({ container, tabs }: Props) {
  const tabsContext = useContext(IonTabsContext);
  const { pathname } = useLocation();
  const path = useRef(pathname);
  path.current = pathname;

  useEffect(() => {
    const main = container.current;

    if (main === null) {
      return;
    }

    // The last page each tab showed, for its neighbours' swipes.
    const pages = new Map<string, HTMLElement>();
    let touch: Swipe | null = null;
    let settling = false;
    // A touch that starts while the pages slide into place moves nothing sideways, to its end.
    let held = false;

    const tabOf = (at: string) => tabs.find((tab) => at === `/${tab}` || at.startsWith(`/${tab}/`));
    const outlet = () => main.querySelector('ion-router-outlet');
    const visiblePage = () => [...(outlet()?.children ?? [])].find((page): page is HTMLElement => page.classList.contains('ion-page') && !page.classList.contains('ion-page-hidden'));
    const neighbour = (tab: string) => {
      const page = pages.get(tab);
      return page?.isConnected === true ? page : undefined;
    };

    const onEnter = (event: Event) => {
      const page = event.target as HTMLElement;
      const tab = tabOf(path.current);

      if (page.parentElement?.tagName === 'ION-ROUTER-OUTLET' && tab !== undefined) {
        pages.set(tab, page);
      }
    };

    const onStart = (event: TouchEvent) => {
      touch = null;
      held = settling;
      const tab = tabs.indexOf(path.current.slice(1));
      const current = visiblePage();

      if (settling || event.touches.length !== 1 || tab === -1 || current === undefined) {
        return;
      }

      const point = event.touches[0]!;
      pages.set(tabs[tab]!, current);
      touch = { tab, current, target: event.target as Element, startX: point.clientX, startY: point.clientY, originX: 0, decided: false, offset: 0, samples: [] };
    };

    const onMove = (event: TouchEvent) => {
      // Ionic's swipe back would otherwise take it, and go back in the history to whichever tab
      // came before.
      if (held) {
        event.stopPropagation();
        return;
      }

      if (touch === null || event.touches.length !== 1) {
        return;
      }

      const point = event.touches[0]!;

      if (!touch.decided) {
        const dx = point.clientX - touch.startX;
        const dy = point.clientY - touch.startY;

        if (Math.hypot(dx, dy) < DECISION_DISTANCE) {
          return;
        }

        // Mostly sideways, before the page started scrolling, and not something else's swipe.
        if (Math.abs(dx) < Math.abs(dy) * 1.2 || !event.cancelable || ownSwipe(touch.target, main, dx)) {
          touch = null;
          return;
        }

        touch.decided = true;
        touch.originX = point.clientX;
        (document.activeElement as HTMLElement | null)?.blur();
        main.querySelectorAll<HTMLIonItemSlidingElement>('ion-item-sliding.item-sliding-active-slide').forEach((row) => void row.close());
        // Lets Ionic know the touch is taken: a row that lit up under the finger goes back.
        document.dispatchEvent(new CustomEvent('ionGestureCaptured', { detail: { gestureName: 'tab-swipe' } }));
      }

      // From here on the touch is the swipe's alone: the page does not scroll, a row does not slide.
      event.preventDefault();
      event.stopPropagation();
      touch.samples = [...touch.samples.filter((sample) => event.timeStamp - sample.time < VELOCITY_WINDOW_MS), { x: point.clientX, time: event.timeStamp }];
      layOut(touch, point.clientX - touch.originX);
    };

    const onEnd = (event: TouchEvent) => {
      const swipe = touch;
      touch = null;

      if (swipe === null || !swipe.decided) {
        return;
      }

      event.stopPropagation();
      const width = outlet()?.clientWidth ?? window.innerWidth;
      // The finger's speed over its last moves: one that stopped before lifting has none.
      const recent = swipe.samples.filter((sample) => event.timeStamp - sample.time < VELOCITY_WINDOW_MS);
      const first = recent[0];
      const last = recent.at(-1);
      const velocity = first !== undefined && last !== undefined && last.time > first.time ? (last.x - first.x) / (last.time - first.time) : 0;
      const direction = Math.sign(swipe.offset);
      const to = tabs[swipe.tab - direction];
      const far = Math.abs(swipe.offset) > width * COMMIT_SHARE;
      const flicked = Math.abs(swipe.offset) > FLICK_MIN_DISTANCE && velocity * direction > FLICK_VELOCITY;
      const moving = [swipe.current, swipe.next, swipe.previous].filter((page) => page !== undefined);

      settling = true;
      moving.forEach((page) => page.classList.add('tab-swipe-settle'));

      if (event.type === 'touchend' && to !== undefined && direction !== 0 && (far || flicked)) {
        // The rest of the way, at the finger's speed if it was fast, never slower than a quick slide.
        const remaining = width - Math.abs(swipe.offset);
        const duration = Math.min(SETTLE_MS, Math.max(MIN_SETTLE_MS, remaining / Math.max(Math.abs(velocity), 0.001)));
        const entering = direction < 0 ? swipe.next : swipe.previous;
        let arrived: HTMLElement | undefined;

        // A tab not visited yet: its page slides in from where it would have been, once Ionic adds it.
        const observer = new MutationObserver((records) => {
          const added = records.flatMap((record) => [...record.addedNodes]).find((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains('ion-page'));

          if (added !== undefined) {
            observer.disconnect();
            arrived = added;
            moving.push(added);
            added.classList.add('tab-swipe-peek');
            added.style.transform = `translateX(${swipe.offset - direction * width}px)`;
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                added.classList.add('tab-swipe-settle');
                added.style.transitionDuration = `${SETTLE_MS}ms`;
                added.style.transform = '';
              }),
            );
          }
        });

        if (entering === undefined) {
          const holder = outlet();

          if (holder !== null) {
            observer.observe(holder, { childList: true });
          }
        }

        // The page that leaves stays shown while it slides away, even once Ionic has hidden it.
        swipe.current.classList.add('tab-swipe-peek');
        moving.forEach((page) => (page.style.transitionDuration = `${duration}ms`));
        swipe.current.style.transform = `translateX(${direction * width}px)`;

        if (entering !== undefined) {
          entering.style.transform = '';
        }

        tabsContext.selectTab(to);
        // Done once the slide is over and Ionic shows the new page, or after a while whatever happens.
        const entered = new Promise<void>((resolve) => {
          const enter = () => {
            main.removeEventListener('ionViewDidEnter', enter, true);
            resolve();
          };
          main.addEventListener('ionViewDidEnter', enter, true);
          setTimeout(enter, ENTER_TIMEOUT_MS);
        });
        void Promise.all([entered, wait(entering === undefined ? SETTLE_MS + 50 : duration)]).then(async () => {
          observer.disconnect();

          if (arrived !== undefined) {
            await wait(SETTLE_MS);
          }

          settle(moving);
        });
      } else {
        // Back where it started: past the first or last tab, or not far enough.
        moving.forEach((page) => {
          page.style.transitionDuration = `${SETTLE_MS}ms`;
          page.style.transform = '';
        });
        void wait(SETTLE_MS).then(() => settle(moving));
      }
    };

    /** Places the current page at the finger and its neighbour beside it, or holds it back past the ends. */
    const layOut = (swipe: Swipe, dx: number) => {
      const width = outlet()?.clientWidth ?? window.innerWidth;
      const nextTab = tabs[swipe.tab + 1];
      const previousTab = tabs[swipe.tab - 1];
      swipe.next ??= nextTab === undefined ? undefined : neighbour(nextTab);
      swipe.previous ??= previousTab === undefined ? undefined : neighbour(previousTab);
      const beyond = (dx < 0 && nextTab === undefined) || (dx > 0 && previousTab === undefined);
      // iOS's own rubber band: the further the finger goes, the less the page follows.
      swipe.offset = beyond ? Math.sign(dx) * (1 - 1 / ((Math.abs(dx) * 0.55) / width + 1)) * width : dx;
      swipe.current.style.transform = `translateX(${swipe.offset}px)`;

      for (const [page, side] of [
        [swipe.next, 1],
        [swipe.previous, -1],
      ] as const) {
        if (page !== undefined) {
          const shown = Math.sign(swipe.offset) === -side;
          page.classList.toggle('tab-swipe-peek', shown);
          page.style.transform = shown ? `translateX(${swipe.offset + side * width}px)` : '';
        }
      }
    };

    const settle = (moving: HTMLElement[]) => {
      moving.forEach((page) => {
        page.classList.remove('tab-swipe-peek', 'tab-swipe-settle');
        page.style.transform = '';
        page.style.transitionDuration = '';
      });
      settling = false;
    };

    const options = { capture: true, passive: false };
    main.addEventListener('ionViewDidEnter', onEnter, true);
    main.addEventListener('touchstart', onStart, options);
    main.addEventListener('touchmove', onMove, options);
    main.addEventListener('touchend', onEnd, options);
    main.addEventListener('touchcancel', onEnd, options);

    return () => {
      main.removeEventListener('ionViewDidEnter', onEnter, true);
      main.removeEventListener('touchstart', onStart, options);
      main.removeEventListener('touchmove', onMove, options);
      main.removeEventListener('touchend', onEnd, options);
      main.removeEventListener('touchcancel', onEnd, options);
    };
  }, [container, tabs, tabsContext]);

  return null;
}

interface Swipe {
  tab: number;
  current: HTMLElement;
  target: Element;
  startX: number;
  startY: number;
  /** Where the finger was once the touch became a swipe: the page moves from there. */
  originX: number;
  decided: boolean;
  offset: number;
  samples: { x: number; time: number }[];
  next?: HTMLElement | undefined;
  previous?: HTMLElement | undefined;
}

/** How far a finger moves before the touch counts as a swipe or a scroll, as in Ionic's gestures. */
const DECISION_DISTANCE = 10;
/** How much of the screen's width a slow swipe has to cover to change tab. */
const COMMIT_SHARE = 0.35;
/** A flick changes tab from this far, at this speed (px/ms) at least. */
const FLICK_MIN_DISTANCE = 24;
const FLICK_VELOCITY = 0.35;
/** How far back the finger's moves count for its speed. */
const VELOCITY_WINDOW_MS = 100;
const SETTLE_MS = 300;
const MIN_SETTLE_MS = 120;
/** How long a swipe waits for Ionic to show the new tab before letting go of its pages. */
const ENTER_TIMEOUT_MS = 1500;

/**
 * Whether the swipe belongs to what is under the finger: something that scrolls sideways (the
 * channel strip), a control dragged sideways, the focused field's text, or a row with options on
 * the side the finger uncovers.
 */
function ownSwipe(target: Element, main: Element, dx: number): boolean {
  if (target.closest('ion-segment, ion-toggle, ion-range') !== null || (target.closest('input, textarea') !== null && target.closest('input, textarea') === document.activeElement)) {
    return true;
  }

  const row = target.closest('ion-item-sliding');

  if (row !== null && (row.classList.contains('item-sliding-active-slide') || row.querySelector(`ion-item-options[side="${dx < 0 ? 'end' : 'start'}"]`) !== null)) {
    return true;
  }

  for (let element: Element | null = target; element !== null && element !== main; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowX;

    if ((overflow === 'auto' || overflow === 'scroll') && element.scrollWidth > element.clientWidth) {
      return true;
    }
  }

  return false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
