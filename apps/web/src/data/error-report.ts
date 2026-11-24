import { ServerError } from './api';

/** An error the app showed a sentence for, and when it happened: what its details tell. */
export interface Failure {
  error: unknown;
  at: number;
}

export function failed(error: unknown, at = Date.now()): Failure {
  return { error, at };
}

/** Where the app runs, for the details: nothing in it names the user or their channels. */
export interface ReportPlace {
  /** The commit the app was built from (vite.config.ts). */
  version: string | null;
  userAgent: string;
  /** The screen's path, without its query, which may name a channel. */
  screen: string;
}

/** How many causes deep the details go: a cause rarely has one of its own. */
const CAUSES_SHOWN = 3;

/**
 * Everything known about an error, as plain text to copy and paste when asking for help: when it
 * happened, the app's version, the browser, the request and the server's answer for a request
 * that failed, then the error itself with its stack and its causes. The request's query, a
 * request's body and the screen's query stay out: they would name the groups the device reads,
 * a channel or a search.
 */
export function errorReport({ error, at }: Failure, place: ReportPlace): string {
  const lines = [`Time: ${new Date(at).toISOString()}`, `App: ${place.version ?? 'unknown version'}`, `Screen: ${place.screen}`, `Browser: ${place.userAgent}`];

  if (error instanceof ServerError) {
    lines.push(`Request: ${error.request ?? 'none'}`, `Status: ${error.status === 0 ? 'no answer' : error.status}`, `Code: ${error.code}`);

    if (error.answer !== undefined && error.answer !== '') {
      lines.push(`Answer: ${error.answer}`);
    }
  }

  return [...lines, '', ...describe(error, CAUSES_SHOWN)].join('\n');
}

/** An error's name, message and stack, then its cause's. */
function describe(error: unknown, causes: number): string[] {
  if (!(error instanceof Error)) {
    return [shown(error)];
  }

  const head = `${error.name}: ${error.message}`;
  // Chrome's stack starts with the name and message; Safari's and Firefox's hold only the frames.
  const stack = error.stack ?? '';
  const frames = (stack.startsWith(head) ? stack.slice(head.length) : stack)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const lines = [head, ...frames.map((frame) => `  ${frame}`)];

  return error.cause === undefined || causes === 0 ? lines : [...lines, 'Caused by:', ...describe(error.cause, causes - 1)];
}

/** Something thrown that isn't an Error. */
function shown(value: unknown): string {
  try {
    return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}
