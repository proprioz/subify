import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Writes wrangler.deploy.toml: wrangler.toml with one instance's own values, read from the
 * environment, so that the repository holds none. CI passes the repository's variables; by hand:
 * `INSTANCE_URL=https://videos.example.org D1_DATABASE_ID=… INSTANCE_NAME=… pnpm deploy:config`.
 *
 * - INSTANCE_URL (required): https://<domain>. Gives the route, PUBLIC_BASE_URL and the contact
 *   Wikidata asks automated clients for.
 * - D1_DATABASE_ID (required): the id `wrangler d1 create` gave.
 * - INSTANCE_NAME (required), OPERATOR_NAME, OPERATOR_CONTACT, SEEDED_CHANNELS_PER_DAY (optional:
 *   wrangler.toml's values stay).
 * - MESSAGES_TO (optional): turns the contact form on, with a send_email binding to that address
 *   only. MESSAGES_FROM: the sender, contact@<domain> by default.
 */

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

function required(name: string): string {
  const value = process.env[name]?.trim() ?? '';

  if (value === '') {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim() ?? '';

  return value === '' ? null : value;
}

const url = new URL(required('INSTANCE_URL'));

if (url.protocol !== 'https:' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
  throw new Error('INSTANCE_URL must be https://<domain>, without a path.');
}

const databaseId = required('D1_DATABASE_ID');

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(databaseId)) {
  throw new Error('D1_DATABASE_ID must be the id `wrangler d1 create` gave.');
}

const origin = url.origin;
let config = readFileSync(here('../wrangler.toml'), 'utf8');

/** Replaces the one `key = …` line; a key missing from wrangler.toml is a mistake, not a skip. */
function set(key: string, value: string): void {
  const line = new RegExp(`^${key} = .*$`, 'gm');
  const found = config.match(line)?.length ?? 0;

  if (found !== 1) {
    throw new Error(`wrangler.toml has ${found} lines for ${key}, not one.`);
  }

  config = config.replace(line, `${key} = ${value}`);
}

// JSON strings are valid TOML basic strings.
const text = (value: string) => JSON.stringify(value);

set('routes', `[{ pattern = ${text(url.hostname)}, custom_domain = true }]`);
set('database_id', text(databaseId));
set('INSTANCE_NAME', text(required('INSTANCE_NAME')));
set('PUBLIC_BASE_URL', text(origin));
set('WIKIDATA_USER_AGENT', text(`SubifyBot/1.0 (${origin}) feed-reader`));

for (const key of ['OPERATOR_NAME', 'OPERATOR_CONTACT', 'SEEDED_CHANNELS_PER_DAY', 'MESSAGES_TO']) {
  const value = optional(key);

  if (value !== null) {
    set(key, text(value));
  }
}

// The contact form sends through Cloudflare's send_email binding, to MESSAGES_TO only.
const messagesTo = optional('MESSAGES_TO');

if (messagesTo !== null) {
  // Cloudflare sends only from an address of a domain it handles mail for: the instance's own.
  set('MESSAGES_FROM', text(optional('MESSAGES_FROM') ?? `contact@${url.hostname}`));
  config += `\n[[send_email]]\nname = "MESSAGES"\nallowed_destination_addresses = [${text(messagesTo)}]\n`;
}

writeFileSync(here('../wrangler.deploy.toml'), `# Written by scripts/deploy-config.ts; not committed.\n${config}`);
console.log(`wrangler.deploy.toml written for ${url.hostname}.`);
