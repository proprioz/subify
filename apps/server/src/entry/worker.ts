import { createApp } from '../app';
import { deriveKeys, type ServerKeys } from '../crypto/keys';
import { loadConfig } from '../config';
import { CoordinatorObject, coordinatorOf } from '../workers/coordinator';
import { D1Adapter } from '../workers/d1';
import { workersThumbnailModules } from '../workers/thumbnails';
import { thumbnailEncoder } from '../catalog/thumbnails';

// Durable Object classes are exported by the Worker's entry module.
export { CoordinatorObject };
import { systemClock, type Platform } from '../platform';
import { sources } from '../sources';
import { runDueTasks } from '../tasks';

/**
 * Cloudflare Workers entry point. Static files never reach it: wrangler.toml sends only /api/*
 * here and serves the PWA from the assets.
 */

interface Env {
  DB: D1Database;
  COORDINATOR: DurableObjectNamespace<CoordinatorObject>;
  /** The contact form's way out, added by the deploy script when MESSAGES_TO is set. */
  MESSAGES?: SendEmail;
  PUBLIC_BASE_URL?: string;
  CONTACT_URL?: string;
  POLL_BATCH_SIZE?: string;
  RETENTION_DAYS?: string;
  NEW_CHANNELS_PER_HOUR?: string;
  NEW_CHANNELS_PER_DAY?: string;
  ONLINE_LOOKUPS_PER_MINUTE?: string;
  SEEDED_CHANNELS_PER_DAY?: string;
  INSTANCE_NAME?: string;
  /** Set by CI at deploy (`--var COMMIT:<sha>`), never in wrangler.toml. */
  COMMIT?: string;
  /** 32 bytes in base64, set with `wrangler secret put MASTER_SECRET`, never in wrangler.toml. */
  MASTER_SECRET?: string;
}

const app = createApp({ sources });

/** Derived once per isolate: HKDF and the VOPRF key pair cost a few milliseconds. */
let derived: { secret: string; keys: Promise<ServerKeys> } | undefined;

function keysFor(secret: string): Promise<ServerKeys> {
  if (derived?.secret !== secret) {
    derived = { secret, keys: deriveKeys(base64(secret)) };
  }

  return derived.keys;
}

function base64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** One per isolate: its WASM modules are set up at the first thumbnail. */
const thumbnails = thumbnailEncoder(workersThumbnailModules);

function platformFor(env: Env, ctx: ExecutionContext): Platform {
  const config = loadConfig({ ...env });

  return {
    clock: systemClock,
    fetch: (url, init) => fetch(url, init),
    afterResponse: (work) => ctx.waitUntil(work),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: Math.random,
    db: new D1Adapter(env.DB),
    config,
    keys: keysFor(env.MASTER_SECRET!),
    coordinator: coordinatorOf(env.COORDINATOR),
    mailer: env.MESSAGES === undefined ? null : async ({ to, from, replyTo, subject, text }) => void (await env.MESSAGES!.send({ to, from, replyTo, subject, text })),
    thumbnails,
  };
}

export default {
  fetch(request, env, ctx) {
    // Every server names itself: until INSTANCE_NAME is set, it refuses to serve.
    if ((env.INSTANCE_NAME ?? '').trim() === '') {
      return new Response('INSTANCE_NAME is not set.', { status: 503 });
    }

    // Without its secret, the server would write nothing it could read back: it refuses to serve
    // until `wrangler secret put MASTER_SECRET`.
    if (env.MASTER_SECRET === undefined) {
      return new Response('MASTER_SECRET is not set.', { status: 503 });
    }

    // Read lazily, so only the route that answers the connection check ever looks at it.
    const connectionCountry = () => (typeof request.cf?.country === 'string' ? request.cf.country : null);

    return app.fetch(request, { platform: platformFor(env, ctx), connectionCountry }, ctx);
  },

  scheduled(_controller, env, ctx) {
    if (env.MASTER_SECRET === undefined) {
      return;
    }

    ctx.waitUntil(runDueTasks(platformFor(env, ctx), sources));
  },
} satisfies ExportedHandler<Env>;
