/**
 * The only way the server writes logs. It takes a fixed event name and, for an error, only the
 * error's name: messages can carry URLs, and the server never logs a URL or an IP.
 */
export function logError(event: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  console.error(`${event}: ${name}`);
}

/** A measure the server keeps no other record of, as a fixed event name and a number: nothing about a request. */
export function logMeasure(event: string, value: number): void {
  console.info(`${event}: ${value.toFixed(3)}`);
}
