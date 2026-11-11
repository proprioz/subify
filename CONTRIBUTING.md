# Contributing to Subify

What the app does and the design decisions behind it (D1, D2…) are in [docs/FEATURES.md](docs/FEATURES.md). How to report a security issue, and how the app protects its users, is in [SECURITY.md](SECURITY.md). Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Non-negotiable principles

Never break these without the maintainer's explicit approval. If a feature conflicts with them, don't build it: say so and propose an alternative.

- **No account, no device id, no cookie, no token.** Requests carry nothing that identifies a user.
- **Public data only, no API key, no account at any platform.** The server reads what the platform publishes for everyone, the way a feed reader does: the public Atom feeds of channels and their playlists; oEmbed, to resolve a video link, and to read the `@handle` of a channel entering the catalog without one, from its latest video; and a channel's public page, read once when the channel enters the catalog, for its id, title and avatar (the same read resolves a `@handle`, `/c/` or `/user/` link). Nothing else: no YouTube Data API, no private API (InnerTube, `youtubei/v1`), no other page. When WebSub is on, the server also sends subscription requests to the platform's WebSub hub (`pubsubhubbub.appspot.com`), which then pushes new uploads to it. Images are read as images, each once: a channel's avatar when the channel enters the catalog, and each new video's thumbnail (`mqdefault.jpg`, 320×180) when it arrives, kept encrypted for 30 days (D3). The page read carries a fixed consent cookie (`SOCS`, see `src/sources/youtube/page.ts`), the same for every request: it identifies no one and is sent by the server, never for a user. Outside the platform, the server reads Wikidata's public query service (`query.wikidata.org`) for the dictionary of channel names, with the User-Agent its admin sets (`WIKIDATA_USER_AGENT`), and nothing about users. When its admin sets an address (`MESSAGES_TO`), it also forwards the contact form's messages to it by email (`send_email` on Workers, SMTP on Node) and keeps none of them (`src/contact.ts`).
- **No third-party service that would see users' traffic:** no Sentry, no analytics, no Logpush. The Privacy page says that a hosting platform handles the traffic, without naming it. Self-hosters run the same code on Node.
- **The server never learns, nor keeps, the link between a user and their channels.** A device names a channel only when it adds one the catalog lacks (`POST /add`, D16); otherwise it reads blind evaluations, whole groups and the handle index, and the server learns at most which groups it read. The server may log how it runs (through `src/log.ts`, kept by Workers Logs), never anything that would trace a user's habits: it stores nothing about users, never logs an IP, a requested URL or a list of channels (so no invocation logs on Workers), and the application code never reads `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP` or any other IP header, on any runtime. One exception (D11): `GET /connection` answers the country Cloudflare derives from the request's IP, for the connection check only; only `src/entry/worker.ts` reads it, it is never stored or logged, and no other route may use it. The read routes (`/oprf/evaluate`, `/stream`, `/snapshot`, `/snapshot/thumbnails`, `/lots`, `/handles`) write nothing to the database.
- **No connection on its own, none that tells about the user.** A request must pass two tests. *When*: the app goes online only to serve what the user is doing in it (refreshing or pulling to refresh, adding or looking up a channel, restoring a backup), preparation for that action included; a backup's queue of channels new to the catalog carries on by itself, even after a relaunch. Never because the app launched or came back to the foreground, never on a timer, never in the background without a task the user started; a sync the user started may go on in the background, or resume back in the foreground if the system cut it. *What*: a request carries only what would be the same for anyone making the same gesture, plus what the user chose to send (a channel the catalog lacks, a name searched online); nothing in it identifies the device or ties it to another request. Every connection passes the connection check when it is on. Thumbnails come with an addition, a restore or a refresh, in whole groups' snapshots and thumbnail lots (D3), and are kept on the device; the UI never loads an image from the network, only data: URLs and blobs it already has. The one exception is the browser's own service worker update check (`sw.js`, to the server hosting the app). See D12.
- **The database alone reveals nothing** (D16). Every table but the public dictionary holds fixed-size encrypted blobs, without rowid, keyed by random ids or fixed positions, all rewritten by the pass; no per-channel date, no plaintext column. Never add a readable column, a table in insertion order, or a write between passes that depends on a channel.
- **Trust, or host your own.** The server sees a channel a device adds when the catalog lacks it, and which groups it reads; it keeps nothing about either (D10, D16). The Privacy page says so plainly, and self-hosting stays a first-class path: same code on both runtimes. The app only talks to the server that served it, on the same origin, so a self-hoster installs the app from their own server (D14).
- **Backups are always sealed** with a password (Argon2id + XChaCha20-Poly1305); never write a backup in plain JSON, never store the password. The crypto libraries load on demand. Every version of the app restores the backups of every earlier one: a change to the format raises its version, keeps reading the old ones, and leaves `apps/web/test/fixtures/backup-v1.json` (and later versions' fixtures) untouched.
- **Simplicity.** A minimal v1; every addition must plug in later without a rewrite.

## Architecture

```
apps/web         Vite + React + TypeScript, Ionic React 9, @ionic/react-router (React Router 6),
                 vite-plugin-pwa, Dexie (IndexedDB). The PWA.
  src/data/        everything below the UI, tested on Node: Dexie schema, the API client,
                   subscribe/unsubscribe, sync, the encrypted catalog's client (encrypted.ts),
                   the dictionary of channel names (dictionary.ts),
                   feed queries, thumbnails, date labels, sealed
                   backups and their queue, secret code, settings,
                   connection check (ConnectionGate)
  src/app/         AppDataProvider (database, API client, connection check dialog, sync, import
                   queue, theme, install)
                   and SecretFlowProvider (secret code and biometrics dialogs)
  src/ui/          browser helpers: clipboard, WebAuthn biometrics, loading a new version (app-update.ts),
                   install prompt, toasts, icons
  src/theme/       theme.css, the only stylesheet
  src/pages/, src/components/   Ionic screens and pieces
apps/server      Hono, written once for Node and Cloudflare Workers.
  src/config.ts    configuration read from the environment, one parser for both runtimes
  src/instance.ts  the installed app's manifest and icons, for the host the request came to
  src/app.ts       the API, mounted under /api; runtime-independent. Routes are declared with
                   @hono/zod-openapi (request and answer schemas); `AppType` gives the PWA's
                   `hc` client their types
  openapi.json     the API's contract, generated from the routes and checked by a test
  src/catalog/     the catalog (D16): its pass (pass.ts), what it does to each slot (tend.ts,
                   slot-items.ts, schedule.ts), the updates waiting for it (updates.ts) in the
                   coordinator (coordinator.ts), with the new-channel budgets (budgets.ts), adding
                   a channel (submit.ts, add.ts, avatars.ts), WebSub (websub.ts), the thumbnail
                   ring (ring.ts), seeding (seeding.ts, candidates.ts, seed-pool.ts), blind
                   evaluation for devices (blind.ts), the sync stream (stream.ts), the handle
                   index (handles.ts), group snapshots (snapshot.ts), its sizes (sizing.ts),
                   and vault.ts, the only access to its tables
  src/search/      finding a channel by its name: the Wikidata dictionary (dictionary.ts)
  src/sources/     source adapters; youtube/ holds everything YouTube-specific
  src/http.ts      the only way to reach a platform: allow-listed hosts, timeout, size cap
  src/db/db.ts     the Db interface over D1 and SQLite
  src/db/query.ts  the Kysely query builder: compiles typed queries, the Db adapters run them
  src/db/schema.ts the tables' types, generated from the migrations and checked by a test
  src/platform.ts  what the app needs from the runtime: Clock, Fetcher, AfterResponse
  src/tasks.ts     scheduled tasks; one trigger per minute, each task says how often it is due
  src/log.ts       the only way to log (event name + error name, never a message or URL)
  src/crypto/      the keys derived from the master secret (keys.ts), sealing payloads with AES-GCM (aead.ts)
  src/entry/worker.ts  Workers entry: D1, Cron Trigger, ctx.waitUntil (the PWA is served by `[assets]` in wrangler.toml)
  src/entry/node.ts    Node entry: SQLite, internal scheduler, tracked promises, serves the PWA
  src/node/        Node-only code (SQLite adapter and migrations, scheduler, detached work, serving the PWA,
                   the master secret's file)
  src/workers/     Workers-only code (D1 adapter, the coordinator's Durable Object)
  migrations/      SQL migrations, wrangler d1 format, shared by D1 and SQLite; Node refuses a database that
                   holds a migration it doesn't know
  scripts/         recording fixtures, filling the dev catalog
  test/shared/     business tests, run on both runtimes through `#harness`
  test/node/, test/workers/   runtime-specific tests
  test/support/, test/harness/, test/fixtures/   fakes, the two-runtime harness, recorded feeds
packages/shared  The API's contract. `./schemas`: the Zod schemas, imported by the server only.
                 `.`: the types inferred from them and the request limits, with no runtime
                 dependency; the PWA imports only this entry, so Zod never reaches its bundle.
                 `./codec`: the fixed-size payload codecs, `./oprf`: the VOPRF (@noble/curves), loaded
                 on demand by the PWA. Neither depends on Zod.
docs/            Project documents.
```

- **The catalog** (docs/FEATURES.md, D16). The server maintains it on its own (WebSub + adaptive polling, inside the pass); it reads a channel online only when one new to the catalog enters it: a user adds it, or the server seeds it. The PWA names no channel it follows (`src/data/encrypted.ts`): a blind evaluation gives each channel's slot and key, it downloads whole groups (snapshots, the sync stream) and opens only its own entries, and finds a @handle through the handle index. Only a channel the catalog lacks, or a video link, is sent in clear, to `POST /add`; an hour later a refresh checks the snapshots, and a channel still missing goes back to the import queue. A restored backup reads the snapshots of its groups, then their thumbnails, and queues the channels they lack (`src/data/follow-many.ts`).
- **One app, two runtimes.** The entry points are thin: they build a `Platform` (clock, fetch, work after response, and the `Db`) and pass it with each request as Hono bindings (`c.env.platform`). The app is built once per process or isolate.
- **Source adapter.** Everything YouTube-specific (URL resolution, which feeds to read, classification) lives behind a source adapter. The catalog, the sync and the client must not depend on YouTube details, so that other video platforms can be added later.
- **The pass.** One Cron Trigger (or the Node scheduler) every minute runs `runDueTasks` (src/tasks.ts): seeding, the pass, the dictionary and the search decoys, each deciding itself whether it is due. The pass (`src/catalog/pass.ts`) rewrites every slot every 10 minutes or more (the period grows with the table, `sizing.ts`), and does the ingestion on the way: it applies the updates waiting in the coordinator (WebSub notifications, new channels, thumbnails and changes a pass had no room for), polls the slots whose turn has come, renews their WebSub subscriptions, drops items past `RETENTION_DAYS`, and removes a channel only after 30 days of “not found” that its page confirms. It reads each new video's `mqdefault.jpg` once and keeps it in the thumbnail ring: every pass overwrites the same number of 24 KB cases, the oldest first, so a thumbnail lasts 30 days and an upcoming video's moves to a new case. It also rewrites seeding's rows: the candidates it harvests from descriptions, each with the video citing it, drawn only once that video has left its channel's public feeds (15 newer of its type) and those cited once first, and users' additions by hour of day, halved every week, which set the hours seeding adds at. Each pass publishes one batch of the sync stream, a ring of 30 days of batches: every group gets the same number of entries, the changes sealed under each channel's key and random entries for the rest; changes without room wait for the next pass. Once an hour, it also rebuilds the handle index: one entry per handle, padded to one per slot, sorted and cut into chunks of 4,096 entries. Group snapshots are computed on request and never stored: every slot of a group of about 40 channels (one range of slot ids), each channel sealed under its own key. `POST /api/add` answers at a fixed size and after at least 8 seconds, failures included, whether the catalog knew the channel or not; a channel new to the catalog waits in the coordinator until a time drawn within 6 hours (`ENTRY_DELAY`), and enters at the first pass after it. Nothing else writes to the catalog's tables: an addition, the WebSub callback and the budgets only queue in the coordinator (a Durable Object on Workers, memory on Node).
- **Seeding** (docs/FEATURES.md, D15). Off by default and turned on for the official instance (`SEEDED_CHANNELS_PER_DAY`), the server adds channels to the catalog on its own, so that a channel there doesn't show that someone follows it, not even to the server's operator: only channels that the catalog's video descriptions link to, drawn from the encrypted pool, never from a list shipped with the code, at the hours users add channels at, slowing down until half its capacity. A seeded channel goes through the same code as a user's channel (`submitInput`): never add anything (field, log, budget) that would tell the two apart.
- **Cloudflare Workers Paid plan** (D9). The pass needs it: up to 30 s of CPU per Cron Trigger, 1,000 D1 queries per invocation, D1's row-write allowance. Requests stay small: a route reads one group, one chunk or one slot, and evaluations are batched by 10 or 50.

## Conventions

- **Ionic components** rather than hand-styled HTML. Use the Ionic docs for **version 9**.
- **Theme only through Ionic's CSS variables in `apps/web/src/theme/theme.css`.** No Tailwind, no inline styles, no other stylesheet. Dark mode is Ionic's class-based dark palette (`ion-palette-dark`).
- **Navigation only through `@ionic/react-router`** (`IonReactRouter`, `Route` with `element`, `Navigate`, `useIonRouter`). Only navigate to the app's own fixed routes: never pass a path that comes from user input or the network to `navigate()` or `<Link>` (see the ignored advisories in `pnpm-workspace.yaml`).
- **Server logic stays runtime-independent.** No `process`, `node:*`, `D1Database`, `ExecutionContext` or Cloudflare globals outside `src/entry/`, `src/node/` and `src/workers/`. `pnpm typecheck` checks the core against both the Node and the Workers types to enforce it.
- **SQL compatible with D1** (SQLite dialect, no extensions, at most 100 bound parameters per query).
- **Queries through Kysely** (`src/db/query.ts`): build them with `query`, pass them through `compile` to `Db`, which infers their rows' type; no SQL strings in the app's code (tests, and the Node migration runner in `src/node/sqlite.ts`, may use plain SQL). Kysely only compiles (its driver refuses `.execute()`): the Db adapters run the SQL, so `batch` stays one transaction on both runtimes, and they refuse a statement over 100 bound parameters on every runtime, so a Node test fails where D1 would. Values are always bound; what Kysely writes as is into the SQL takes only constants written in the code, never a value from a request, the network or the database: `sql.raw`, `sql.lit`, `sql.ref`, `sql.id`, `sql.table`, `eb.ref`, and the names given to `select`, `selectFrom`, `orderBy`. Row types are picked from `src/db/schema.ts`, never written by hand. A new migration updates that file (`vitest -u`). Mapping a row to an API type happens in typed functions (`toApiItem`…): the contract never derives from the tables.
- **Payloads**. Every payload stored in a blob or sent sealed has one codec in `packages/shared/src/codec/`: plain TypeScript over `DataView`, no serialization library. `encode` always returns the codec's exact size, padding included, and applies the documented rule when content doesn't fit (the oldest items go first, a title is cut at a character boundary); it never throws on content. `decode` checks every length, count and range and refuses trailing bytes and unknown flags. The first byte is the format version: a format change raises it, keeps decoding the old ones, and adds a golden fixture next to `apps/server/test/fixtures/payloads/slot-v1.hex` (one per format, sealed handle entries included), never regenerated. Blobs are sealed by `src/crypto/aead.ts`, whose associated data binds each one to its kind, key, version and row. `src/catalog/vault.ts` is the only code that reads or writes a `blob` column (a test checks it): everything else works on typed values. Encrypted tables are `WITHOUT ROWID`, keyed by random ids or fixed positions, and every blob of a table has the same size.
- **Logging** only through `src/log.ts` (the Node entry's startup lines aside: migrations applied, listening port, a master secret generated). Never log a URL, an IP, a request or a channel a user submitted. No request logger middleware.
- **API routes** are declared with `createRoute` from the schemas in `packages/shared/src/schemas.ts`: requests with `z.strictObject` (and `NoQuery`, on every route but `GET /health`), every answer and error status listed except the generic 500. Responses carry `Cache-Control: private` and are versioned (`v`); unknown query parameters and body fields are refused, in the API's error format. A change to the contract updates `apps/server/openapi.json` (`vitest -u`); decide then whether `v` must change. The WebSub callback is the hub's, not the app's: it stays a plain Hono route.
- **Client requests** go to the origin that served the app, through `hc<AppType>` in a single API module, with `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`. An answer in an unknown `v` makes the app load its new version (`updateApp`). Every step the user starts that goes online runs inside `gate.run(api, …)` (the connection check, off by default); steps the app carries on by itself (the import queue) run inside `gate.whenApproved(…)`. When the check is on, each `Api` refuses a request made outside an approved step.
- **UI text in English.** Short, plain, sentence case, typographic punctuation (`’`, `“…”`, `…`). Every icon-only button gets an `aria-label`. Name YouTube only when the text is really about it (“Open in YouTube”); otherwise say “the platform”, “online”, “channels”.
- **Code, comments, commits in English.** Comments explain why, in full sentences; match the density of the surrounding code.
- **Dependencies.** pnpm only. `minimumReleaseAge` refuses versions younger than 7 days: pick an older version rather than bypassing it. The only exception is a security fix with no older fixed version, approved by the maintainer: list its exact versions in `minimumReleaseAgeExclude` (`pnpm-workspace.yaml`) with the reason and the date to remove them. `allowBuilds` lists the only packages allowed to run install scripts. Ask before adding a dependency.

## Tests

Write a test for each case whose usefulness can be justified, and only those. **Every test (or `describe` block) starts with a one-line comment giving its justification**: which real bug, regression or privacy guarantee it protects. Don't test what only mirrors a library (rendering an Ionic component, trivial getters).

- Server business tests go in `apps/server/test/shared/` and run on both runtimes; those that need the app or the database import `createHarness` from `#harness`: they run on Node (better-sqlite3) and in workerd (local D1). A change that breaks one runtime must fail there.
- Use real recorded Atom feeds from `apps/server/test/fixtures/` (`test/fixtures/index.ts`) and `FakeFetch` (`test/support/fake-fetch.ts`), which fails any URL a test did not register. **No test may reach YouTube or any network.**
- To drive the catalog with exact data, use `FakeSource` (`test/support/fake-source.ts`), a made-up platform: it also proves the catalog and the sync do not depend on YouTube.
- Client tests (`apps/web/test/`) cover `src/data/` with `fake-indexeddb` and `FakeServer` (`test/fake-server.ts`), which answers like the API and records every request the app sends.
- A new Dexie version comes with its upgrade and a test that opens data written by the previous version: installed apps keep their data across schema changes.

**Look at UI changes in a browser.** Reading the Ionic markup isn't enough to judge a screen: after any UI change, open the running app (`pnpm dev`, http://localhost:5173) and look at the affected screens at a small device's width (390×844), in light and dark mode.

Before a change is done: `pnpm typecheck`, `pnpm test:all` and `pnpm build` must pass.

## Commands

Run from the repository root unless noted.

| What | Command |
|---|---|
| Install | `pnpm install` |
| Develop without Docker | `pnpm dev` (Node server on :8787 with hot reload, Vite on :5173 proxying `/api`) |
| Develop with Docker | `docker compose up`, then open http://localhost:5173 |
| Check the Worker entry locally | `pnpm dev:worker` (builds the PWA, runs `wrangler dev` on :8787) |
| Trigger the cron under `wrangler dev` | `curl "http://localhost:8787/cdn-cgi/local/scheduled"` |
| Typecheck everything | `pnpm typecheck` |
| Tests on Node only (fast) | `pnpm test` |
| Tests on both runtimes | `pnpm test:all` |
| Server tests on Workers only | `pnpm --filter @subify/server test:workers` |
| Re-record the YouTube fixtures (the only script that contacts YouTube) | `pnpm --filter @subify/server fixtures:record` |
| Fill the development catalog from the fixtures, without any request | `pnpm --filter @subify/server dev:seed` |
| Build the PWA, the Node bundle and the Worker bundle | `pnpm build` |
| New D1 migration | `pnpm --filter @subify/server exec wrangler d1 migrations create subify <name>` |
| Apply migrations to the local D1 | `pnpm --filter @subify/server exec wrangler d1 migrations apply subify --local` |

Configuration is described in [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md#variables).

## Deployment

**An instance on Workers is deployed by GitHub Actions, never by hand.** Every push to `main` runs `.github/workflows/ci.yml`: typecheck, tests on both runtimes, build, and the dependency audit. Only when all of them pass does its `deploy` job apply the D1 migrations, deploy the Worker with the PWA and the commit (`COMMIT`), and check that `/api/health` reports that commit. To ship a change, merge it into `main`; to stop a bad one, revert it on `main`.

- **Migrations only add** (tables, columns, indexes): they run before the new code, while the previous version still serves requests, and must not break it. D1 takes a backup before applying them.
- **What the job needs**, in the repository's settings: the secret `CLOUDFLARE_API_TOKEN` (an API token made from Cloudflare's “Edit Cloudflare Workers” template, plus “D1: Edit”, limited to the account and the instance's zone) and the variables `CLOUDFLARE_ACCOUNT_ID`, `INSTANCE_URL` (`https://<domain>`), `D1_DATABASE_ID` and `INSTANCE_NAME`, plus, optionally, `OPERATOR_NAME`, `OPERATOR_CONTACT`, `SEEDED_CHANNELS_PER_DAY` and `MESSAGES_FROM`, and the optional secret `MESSAGES_TO` (a secret so that the public deploy logs hide it). `wrangler.toml` holds no instance's values: the job writes `wrangler.deploy.toml` from these variables (`scripts/deploy-config.ts`) and deploys with it. Without the variables, the job is skipped: a fork deploys nothing unless it sets its own.
- **By hand, only when GitHub Actions can't** (an outage, a broken workflow), from a clean checkout of `main` that passed CI: `pnpm --filter @subify/web build`, `pnpm --filter @subify/server deploy:config` with the same variables in the environment, then `pnpm --filter @subify/server exec wrangler d1 migrations apply subify --remote --config wrangler.deploy.toml` and `pnpm --filter @subify/server exec wrangler deploy --config wrangler.deploy.toml`.

To run your own instance on Workers, see [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md#on-cloudflare-workers).

## Git

One commit per logical change, with a short imperative subject and a body that explains what changed and why.
