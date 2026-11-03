/** How long a new version may take to install before the app gives up and keeps running. */
const INSTALL_TIMEOUT = 30_000;

let updating: Promise<void> | null = null;

/**
 * Whether a newer version of the app took over from the one this page runs. At launch the browser
 * checks `sw.js` (D12): a new service worker installs and takes over at once (it skips waiting),
 * but the page keeps running the old code, whose lazy chunks the new deploy no longer serves.
 */
let replaced = false;
const replacedListeners = new Set<() => void>();

// A page the service worker did not load gets it on first install: that is no new version.
if (navigator.serviceWorker?.controller) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    replaced = true;
    replacedListeners.forEach((listener) => listener());
  });
}

// A lazy chunk that fails to load is likely one the new deploy removed (the error still reaches the caller).
window.addEventListener('vite:preloadError', () => void updateApp());

/** Whether a newer version of the app has taken over from the code this page runs. */
export function appReplaced(): boolean {
  return replaced;
}

/** Calls `listener` once a newer version of the app has taken over; returns the unsubscribe. */
export function onAppReplaced(listener: () => void): () => void {
  if (replaced) {
    listener();
  }

  replacedListeners.add(listener);

  return () => replacedListeners.delete(listener);
}

/**
 * Loads the server's version of the app, when the server answered in a format this one does not
 * know, a lazy chunk failed to load, or the user asked. The page and the server come from the same
 * deploy, so a newer server always has a newer app: when it already took over the page reloads;
 * otherwise the service worker fetches it, takes over (it skips waiting) and the page reloads.
 * Without a service worker, or with nothing new to install, the app keeps running and shows the error.
 */
export function updateApp(): Promise<void> {
  if (replaced) {
    window.location.reload();

    return Promise.resolve();
  }

  updating ??= (async () => {
    try {
      const registration = await navigator.serviceWorker?.getRegistration();

      if (registration === undefined) {
        return;
      }

      await registration.update();

      if (registration.installing === null && registration.waiting === null) {
        return;
      }

      const controlled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), INSTALL_TIMEOUT);

        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          { once: true },
        );
      });

      if (controlled) {
        window.location.reload();
      }
    } catch {
      // The update check failed: the next launch tries again.
    } finally {
      updating = null;
    }
  })();

  return updating;
}
