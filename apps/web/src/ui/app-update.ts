/** How long a new version may take to install before the app gives up and keeps running. */
const INSTALL_TIMEOUT = 30_000;

let updating: Promise<void> | null = null;

/**
 * Loads the server's version of the app, when the server answered in a format this one does not
 * know. The page and the server come from the same deploy, so a newer server always has a newer
 * app: the service worker fetches it, takes over (it skips waiting) and the page reloads. Without a
 * service worker, or with nothing new to install, the app keeps running and shows the error.
 */
export function updateApp(): Promise<void> {
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
