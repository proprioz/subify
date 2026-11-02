import { type Api, ServerError } from './api';
import { getMeta, setMeta, type SubifyDb } from './db';

/**
 * The connection check: when it is on in Settings (off by default, saved in
 * backups), the app first asks the server which country it places the connection in, shows it,
 * and sends nothing else until the user continues. Handy to make sure a VPN is on. The user may
 * have their answer remembered for a while or until the app closes; that is never in backups,
 * and turning the check on or off forgets it.
 */

/** How long an approval is remembered. */
export type ConnectionTrust = 'once' | '5-minutes' | '1-hour' | '1-day' | 'until-app-closes';

export const CONNECTION_TRUSTS: readonly { value: ConnectionTrust; label: string }[] = [
  { value: 'once', label: 'Don’t remember' },
  { value: '5-minutes', label: 'For 5 minutes' },
  { value: '1-hour', label: 'For 1 hour' },
  { value: '1-day', label: 'For 1 day' },
  { value: 'until-app-closes', label: 'Until the app closes' },
];

const MINUTE = 60 * 1000;
const DURATIONS: Partial<Record<ConnectionTrust, number>> = { '5-minutes': 5 * MINUTE, '1-hour': 60 * MINUTE, '1-day': 24 * 60 * MINUTE };

/** A remembered approval: until a time, or for one launch of the app. */
interface Remembered {
  until?: number;
  launch?: string;
}

export async function connectionCheckOn(db: SubifyDb): Promise<boolean> {
  return (await getMeta<boolean>(db, 'checkConnection')) === true;
}

export async function setConnectionCheck(db: SubifyDb, on: boolean): Promise<void> {
  await db.transaction('rw', db.meta, async () => {
    await setMeta(db, 'checkConnection', on);
    await db.meta.delete('connectionTrust');
  });
}

/** Shows the country (null when the server can’t tell) and resolves with the user’s choice, or null when they cancel. */
export type AskConnection = (country: string | null) => Promise<ConnectionTrust | null>;

export function isCancelled(error: unknown): boolean {
  return error instanceof ServerError && error.code === 'cancelled';
}

/** Every step that goes online passes through here, and every Api checks it before each request. */
export class ConnectionGate {
  /** Identifies this launch, for “Until the app closes”: a new launch builds a new gate. It never leaves the device. */
  private readonly launch = crypto.randomUUID();
  /** Approved steps still running: their requests may leave even if the approval was not remembered. */
  private running = 0;
  private deciding: Promise<boolean> | null = null;

  constructor(
    private readonly db: SubifyDb,
    private readonly ask: AskConnection,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Whether the app may go online without asking: the check is off, or an approval is remembered. */
  async approved(): Promise<boolean> {
    if (!(await connectionCheckOn(this.db))) {
      return true;
    }

    const remembered = await getMeta<Remembered>(this.db, 'connectionTrust');

    return remembered !== undefined && ((remembered.until ?? 0) > this.now() || remembered.launch === this.launch);
  }

  /**
   * Runs a step that goes online through `api`, once the user has approved the connection when
   * the check asks for it. Throws a 'cancelled' ServerError when they cancel.
   */
  async run<T>(api: Api, step: () => Promise<T>): Promise<T> {
    // Steps that start while a decision is pending (a refresh while a channel is being added)
    // share it, and so one dialog.
    this.deciding ??= (async () => (await this.approved()) || this.confirm(api))().finally(() => {
      this.deciding = null;
    });

    if (!(await this.deciding)) {
      throw new ServerError('Nothing was sent.', 'cancelled');
    }

    return this.during(step);
  }

  /** Runs a step the app starts on its own (the import queue) only if it may go online without asking. */
  async whenApproved<T>(step: () => Promise<T>): Promise<T | undefined> {
    return (await this.approved()) ? this.during(step) : undefined;
  }

  /** Given to each Api: a request outside an approved step is a bug, stopped before it leaves. */
  readonly guard = async (): Promise<void> => {
    if (this.running === 0 && !(await this.approved())) {
      throw new ServerError('The connection wasn’t approved.', 'cancelled');
    }
  };

  private async during<T>(step: () => Promise<T>): Promise<T> {
    this.running += 1;

    try {
      return await step();
    } finally {
      this.running -= 1;
    }
  }

  private async confirm(api: Api): Promise<boolean> {
    let country: string | null = null;

    try {
      country = (await api.connection()).country;
    } catch (error) {
      // A server out of reach fails the step as it would have. Any other failure (an older
      // server without the check) leaves the user to judge without a country.
      if (error instanceof ServerError && error.code === 'network') {
        throw error;
      }
    }

    const trust = await this.ask(country);

    if (trust === null) {
      return false;
    }

    const duration = DURATIONS[trust];

    if (duration !== undefined) {
      await setMeta(this.db, 'connectionTrust', { until: this.now() + duration } satisfies Remembered);
    } else if (trust === 'until-app-closes') {
      await setMeta(this.db, 'connectionTrust', { launch: this.launch } satisfies Remembered);
    }

    return true;
  }
}
