import { type Api, ServerError } from './api';
import { setMeta, type SubifyDb } from './db';
import { syncStream } from './encrypted';

export interface SyncResult {
  /** Items of followed channels written. */
  written: number;
}

/** Brings the followed channels up to date from the encrypted catalog's sync stream, newest first (see syncStream). */
export async function syncUpdates(db: SubifyDb, api: Api, now = Date.now(), onProgress?: (share: number) => void): Promise<SyncResult> {
  const result = await syncStream(db, api, await api.catalog(), now, onProgress);
  await setMeta(db, 'lastSyncAt', now);

  return result;
}

/** Whether the app is on screen, and when that changes. The browser's is in AppData. */
export interface Visibility {
  visible(): boolean;
  /** Calls `listener` each time the app goes off or back on screen, until the returned function is called. */
  onChange(listener: () => void): () => void;
}

/**
 * Carries a sync the user asked for through to the end, even if they leave the app meanwhile. The
 * request in flight goes on as long as the system lets the app run; a phone that suspends it may
 * drop the request, and the sync then starts again once the app is back on screen, from the cursor
 * its last page saved. Only a failure to reach the server after the app went off screen is retried:
 * one while it stayed on screen, or an answer from the server, is for the user to see.
 */
export async function syncToTheEnd<T>(run: () => Promise<T>, visibility: Visibility): Promise<T> {
  for (;;) {
    let wentOffScreen = !visibility.visible();
    const stop = visibility.onChange(() => {
      wentOffScreen ||= !visibility.visible();
    });

    try {
      return await run();
    } catch (error) {
      if (!wentOffScreen || !(error instanceof ServerError && error.code === 'network')) {
        throw error;
      }
    } finally {
      stop();
    }

    await backOnScreen(visibility);
  }
}

function backOnScreen(visibility: Visibility): Promise<void> {
  return new Promise((resolve) => {
    if (visibility.visible()) {
      resolve();

      return;
    }

    const stop = visibility.onChange(() => {
      if (visibility.visible()) {
        stop();
        resolve();
      }
    });
  });
}
