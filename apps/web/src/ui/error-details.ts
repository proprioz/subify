import { useIonAlert, useIonToast } from '@ionic/react';
import { useCallback } from 'react';
import { errorReport, type Failure, failed } from '../data/error-report';
import { copyText } from './clipboard';
import { toastPlacement } from './toast';

/**
 * Opens a failure's details, which the user can read and copy to ask for help. Nothing shows
 * them on its own: the sentence the app shows stays short, and a “Details” button opens them.
 */
export function useErrorDetails(): (shown: Failure) => void {
  const [presentAlert] = useIonAlert();

  return useCallback(
    (shown: Failure) => {
      const report = errorReport(shown, { version: __COMMIT__, userAgent: navigator.userAgent, screen: location.pathname });

      void presentAlert({
        header: 'Error details',
        subHeader: 'Copy them to ask for help.',
        message: report,
        cssClass: 'error-details',
        buttons: [
          { text: 'Close', role: 'cancel' },
          {
            text: 'Copy',
            // Copied within the tap, as Safari requires. The dialog stays open and says whether it
            // worked, rather than a toast over the one that may have opened it.
            handler: () => {
              const alert = [...document.querySelectorAll<HTMLIonAlertElement>('ion-alert.error-details')].at(-1);
              void copyText(report, alert?.querySelector<HTMLElement>('.ion-overlay-wrapper') ?? undefined).then((copied) => {
                if (alert !== undefined) {
                  alert.subHeader = copied ? 'Copied. Paste them in your message.' : 'Couldn’t copy them. Select the text instead.';
                }
              });

              return false;
            },
          },
        ],
      });
    },
    [presentAlert],
  );
}

/** A toast for a failure, with a button that opens its details. */
export function useFailureToast(): (message: string, error: unknown) => Promise<void> {
  const [present] = useIonToast();
  const details = useErrorDetails();

  return useCallback(
    (message: string, error: unknown) => {
      const shown = failed(error);

      return present({ message, duration: 6000, ...toastPlacement(), buttons: [{ text: 'Details', handler: () => details(shown) }] });
    },
    [present, details],
  );
}
