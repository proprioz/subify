# Hosting your own Subify

Subify's app only talks to the server it was installed from. Host your own server and install the app from it: the official instance and its host then see nothing of your use. The platform still sees your server read the feeds of the channels in its catalog, as it sees the official one read them.

The same code runs in two ways:

| | Node (SQLite) | Cloudflare Workers (D1) |
|---|---|---|
| Runs on | Any machine with Node: a home server, a VPS, a Raspberry Pi (a NAS through the Docker image, coming soon) | Your Cloudflare account |
| Who sees the traffic | You and your network | Cloudflare |
| Database | One SQLite file | A D1 database |
| New videos | WebSub if the server is reachable over HTTPS, otherwise polling alone | WebSub and polling |
| Connection check (Settings) | Works, but can't show a country | Shows the country Cloudflare sees |

A Docker image is planned, not available yet (see [FEATURES.md](FEATURES.md#coming-next)). The `docker-compose.yml` at the root of the repository is for development only.

## Before you start: who can reach your server

A personal instance's catalog is close to its owner's list of channels. Its database is encrypted, but anyone who can reach the server can test whether it knows a channel they guess, and so guess what you follow. **Keep a personal instance private**: on your home network, behind a VPN such as WireGuard or Tailscale, or behind your reverse proxy's authentication.

A server shared with friends or family mixes everyone's channels. Turning on seeding (`SEEDED_CHANNELS_PER_DAY`, below) adds channels nobody chose, so a channel in the catalog no longer shows that someone follows it.

## On Node

You need Node 24 (the version in `.nvmrc`) and pnpm; `corepack enable` installs the pnpm version the repository asks for.

### Build

```sh
git clone <this repository> subify
cd subify
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @subify/web build          # the app, into apps/web/dist
pnpm --filter @subify/server build:node  # the server, into apps/server/dist/node/node.js
```

### Configure

Create `apps/server/.env` from [apps/server/.env.example](../apps/server/.env.example). A server for one household, reachable only at home:

```sh
INSTANCE_NAME=Videos at home
WEB_DIST=../web/dist
DATABASE_PATH=/var/lib/subify/subify.sqlite
PORT=8787
```

The server generates its master secret next to the database at the first start (see [`MASTER_SECRET`](#master_secret)): back it up.

A server reachable from the internet at `https://videos.example.org`, shared by a few people:

```sh
INSTANCE_NAME=Our videos
OPERATOR_NAME=Alex Martin
OPERATOR_CONTACT=alex@example.org
WEB_DIST=../web/dist
DATABASE_PATH=/var/lib/subify/subify.sqlite
PORT=8787
PUBLIC_BASE_URL=https://videos.example.org
SEEDED_CHANNELS_PER_DAY=10
```

Every variable is described [below](#variables).

### Run

```sh
cd apps/server
node --env-file=.env dist/node/node.js
```

At startup the server creates the database if needed and applies its migrations, then serves the app and its API on the same port. It prints a few lines (the migrations applied, a master secret generated, the port) and logs nothing about requests. A database holding migrations this version doesn't know is refused, with a message saying so: delete the file, and devices add their channels back on their own at their next refresh.

To keep it running, a systemd unit such as `/etc/systemd/system/subify.service`:

```ini
[Unit]
Description=Subify
After=network-online.target

[Service]
User=subify
WorkingDirectory=/opt/subify/apps/server
ExecStart=/usr/bin/node --env-file=.env dist/node/node.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### HTTPS

Browsers install a PWA only over HTTPS (or on `localhost`), and the platform only sends WebSub notifications to an HTTPS address. Put a reverse proxy in front of the server. With [Caddy](https://caddyserver.com), which gets the certificate itself and keeps no access log unless you ask for one:

```
videos.example.org {
	reverse_proxy localhost:8787
}
```

The proxy may pass `X-Forwarded-For`: Subify never reads it, nor any other header that carries an IP address.

### Install the app

Open your server's address in the device's browser and install the app from there (Settings › Install the app). An app installed from another server keeps talking to that one: to move, export a backup in the old app and restore it in the new one.

### Update

```sh
git pull
pnpm install --frozen-lockfile
pnpm --filter @subify/web build
pnpm --filter @subify/server build:node
systemctl restart subify
```

Migrations run at the next start. They only add to the database, so nothing needs to be done by hand. Installed apps load the new version the next time they talk to the server.

### Back up

The SQLite file holds the shared catalog only, encrypted with the master secret: channels, their recent videos, avatars and thumbnails, and the server's own bookkeeping. It holds nothing about users, who keep their lists on their devices. To copy it while the server runs, use `sqlite3 subify.sqlite ".backup subify-backup.sqlite"`. Back the master secret up apart from it: without the secret the copy can't be read, and with both anyone can read the catalog. Losing both is not a disaster: devices add their channels back by themselves.

## On Cloudflare Workers

`apps/server/wrangler.toml` holds no instance's values. A deploy writes `wrangler.deploy.toml` from it and your instance's variables (`scripts/deploy-config.ts`), and uses that file.

You need the Workers Paid plan: the pass that rewrites the catalog needs more CPU time than the Free plan gives a Cron Trigger.

1. Create a database: `pnpm --filter @subify/server exec wrangler d1 create subify` (add `--jurisdiction eu` to keep the data in the European Union), and note its id.
2. Set the master secret, 32 random bytes in base64: `openssl rand -base64 32 | pnpm --filter @subify/server exec wrangler secret put MASTER_SECRET`. Keep a copy offline. Until it is set, the server refuses to serve.
3. Deploy, either from your own fork through GitHub Actions (set the secret and variables described in [CONTRIBUTING.md](../CONTRIBUTING.md#deployment)), or by hand, with your values:

   ```sh
   export INSTANCE_URL=https://videos.example.org   # your domain on Cloudflare
   export D1_DATABASE_ID=…                          # from step 1
   export INSTANCE_NAME="Our videos"
   # Optional: OPERATOR_NAME, OPERATOR_CONTACT, SEEDED_CHANNELS_PER_DAY, SEARCH_SOURCES, MESSAGES_TO, MESSAGES_FROM
   pnpm --filter @subify/web build
   pnpm --filter @subify/server deploy:config
   pnpm --filter @subify/server exec wrangler d1 migrations apply subify --remote --config wrangler.deploy.toml
   pnpm --filter @subify/server exec wrangler deploy --config wrangler.deploy.toml
   ```

   The domain gives the route, `PUBLIC_BASE_URL` and `WIKIDATA_USER_AGENT` (`SubifyBot/1.0 (<INSTANCE_URL>) feed-reader`).

Cloudflare's dashboard can also limit request rates for your domain; with the contact form on, set the [limit per address](#a-limit-per-address).

## Variables

The same names on both runtimes: `.env` on Node, the deploy's variables on Workers (`.dev.vars` for `wrangler dev`, which needs at least `INSTANCE_NAME`). An empty or invalid value falls back to the default.

### `INSTANCE_NAME`

**Required.** Your server's name, what the installed app is called on the home screen and in the app switcher, for example `Videos at home`. Without it, Node refuses to start and a Worker answers every request with an error: an app installed from your server must not pass for another one. Its icon is the Subify icon in blue; only the official server, at `subify.tv`, shows it in red.

The browser reads the name and the icon from your server when the app is installed. Changing the name later changes it for new installs; most devices keep the old one for an app already installed until it is reinstalled.

### `OPERATOR_NAME`, `OPERATOR_CONTACT`

Who runs the server and an address for questions about personal data, shown on the app's Privacy page when someone taps “Show who runs this server”. The server sees its users' IP addresses, which are personal data: if you open your server to others, privacy laws such as the GDPR may ask you to name yourself and give a contact. They never go into the server's requests to YouTube.

Default: empty. The Privacy page then says the server doesn't say who runs it.

While the contact form is on (below), the Privacy page shows the name only: `OPERATOR_CONTACT` stays hidden, and the form reaches you instead.

### `MESSAGES_TO`, `MESSAGES_FROM`, `SMTP_URL`

The contact form: anyone who opens the app, even before unlocking it, can write you a message (a name, an email address and 10 to 2,000 characters) from the welcome screen, the “Contact” link at the bottom of Settings or the Privacy page. The server emails it to `MESSAGES_TO`, which is never shown, and keeps nothing of it. The email is plain text, without invisible or control characters, with links made unclickable (`hxxps://`, `example[.]org`); its Reply-To is the address the sender typed, which nobody checks.

- `MESSAGES_TO`: where messages go. Empty turns the form off.
- `MESSAGES_FROM`: the sender of these emails. On Node it defaults to `MESSAGES_TO`; on Workers, to `contact@<your domain>`.
- `SMTP_URL` (Node only, a secret): the mail server to send through, for example `smtps://user:password@mail.example.org:465` (any URL [nodemailer](https://nodemailer.com/smtp/) takes). Without it the form stays off.

On Workers, the deploy adds a `send_email` binding named `MESSAGES`, limited to `MESSAGES_TO`. The domain needs Cloudflare Email Routing (or Email Sending) turned on; with Email Routing, `MESSAGES_TO` must be one of its verified destination addresses. Through GitHub Actions, `MESSAGES_TO` is an optional repository secret, not a variable: deploy logs are public on a public repository, and GitHub hides secrets in them. `MESSAGES_FROM` is an optional variable.

Default: empty, off.

### `MESSAGES_PER_HOUR`, `MESSAGES_PER_DAY`

How many messages the form sends, all senders together. Past them, the form answers “try again later”. Each message also needs a robot check the device solves when the sender ticks “I’m not a robot” (a proof of work in [ALTCHA](https://altcha.org)'s format, solved by ALTCHA's open-source widget bundled with the app and made by the server itself, with no third party): the server signs a challenge valid 30 minutes (`GET /api/contact`) and accepts each solved one once. A hidden field that robots fill in drops their message silently.

Defaults: 5 per hour, 20 per day.

#### A limit per address

The server never reads an IP address, so it can't limit each sender. Set that limit where the traffic arrives, on the path `/api/contact` (opening the form and sending a message take one request each):

- **On Cloudflare**: a WAF rate limiting rule for your zone (Security › WAF › Rate limiting rules), matching `URI Path equals /api/contact`, counted per IP, with the action Block. The Free plan only allows a 10-second period: for example 1 request per 10 seconds, blocked for 10 seconds. With a paid plan, make it stricter, such as 5 requests per 10 minutes.
- **On Node, with nginx**:

  ```nginx
  # In the http block:
  limit_req_zone $binary_remote_addr zone=contact:1m rate=2r/m;

  # In the server block, before the general location:
  location = /api/contact {
      limit_req zone=contact burst=2 nodelay;
      proxy_pass http://localhost:8787;
  }
  ```

- **On Node, with Caddy**: Caddy has no rate limit of its own; build it with the [rate_limit](https://github.com/mholt/caddy-ratelimit) plugin (`xcaddy build --with github.com/mholt/caddy-ratelimit`) and add a `rate_limit` block for `/api/contact`, keyed on `{remote_host}`.

### `PUBLIC_BASE_URL`

The server's public HTTPS address, for example `https://videos.example.org`. The platform sends its WebSub notifications to it, so new videos arrive within minutes instead of waiting for the next poll.

Leave it empty when the server can't be reached from the internet. WebSub is also off for an `http://` address or a private one (`localhost`, `*.local`, `10.…`, `192.168.…`, `172.16–31.…`, `127.…`). The pass's polling alone then keeps the catalog current: a channel that publishes is checked every few hours.

Default: empty.

### `CONTACT_URL`

An address added to the User-Agent of the server's requests to the platform, for example `https://videos.example.org/about`. Leave it empty, and the User-Agent is a generic `Mozilla/5.0 (compatible; feed reader)` that names no person, no instance and no project.

Default: empty.

### `COMMIT`

The git commit the server was built from, shown by `/api/health` so that anyone can compare it with the public repository. Only a commit id (7 to 40 hex characters) is shown. The CI deploy sets it each time (`wrangler deploy --var COMMIT:<sha>`); on Node, set it to `git rev-parse HEAD` when you build.

Default: empty, and `/api/health` answers `commit: null`.

### `POLL_BATCH_SIZE`

How many channels the server polls per minute, on average: each pass polls `POLL_BATCH_SIZE` per minute of its period. It also sets how many channels the catalog takes: `POLL_BATCH_SIZE × 1440 / 4`, 1,800 with the default. Past that, new channels are refused, since polling couldn't keep up. Raise it for a large catalog (10 takes 3,600 channels).

Default: 5.

### `RETENTION_DAYS`

How long the server keeps videos, in days. Older ones are dropped at the next pass and never stored. The app keeps its own copy beyond that.

Default: 183, about six months.

### `NEW_CHANNELS_PER_HOUR`, `NEW_CHANNELS_PER_DAY`

How many channels new to the catalog may enter it, all users together. Each costs a few reads online, then polling for good. Past the budget, adding a new channel answers “busy, try again later”; a channel the catalog already knows is never refused, and a restored backup keeps trying by itself. Lower them on a server open to strangers.

Defaults: 60 per hour, 500 per day.

### `ONLINE_LOOKUPS_PER_MINUTE`

How many submissions per minute may read the platform, failed ones included: typing a name that matches no channel still costs reads. It keeps a mistyped list or a misbehaving client from making the server hammer the platform.

Default: 10.

### `BLIND_BATCHES_PER_MINUTE`

How many blind lookups per minute the server answers, all devices together. Each lets a device find up to 50 channels in the catalog without naming them, and so also lets anyone test whether up to 50 channels they guessed are in it: the limit bounds how fast someone can probe the catalog against a long list. A device restoring 300 channels uses 6.

Default: 30.

### `SEEDED_CHANNELS_PER_DAY`

How many channels the server adds to its catalog on its own each day, on average, so that a channel in the catalog doesn't show that someone follows it. It takes channels that the catalog's video descriptions link to, once the video citing them has left its channel's public feeds, at the hours users add channels at, once the catalog has its first channels, and stops at half the catalog's capacity. Seeded channels go through the same code as users' channels and can't be told apart from them ([FEATURES.md](FEATURES.md), D15).

For a personal instance, keep it at 0: hide the server instead. For a shared one, 10 to 24 is enough. The official instance uses 24.

Default: 0, off.

### `MASTER_SECRET`

The secret the whole catalog is encrypted with (D16): 32 random bytes in base64 (`openssl rand -base64 32`). On Workers, set it with `pnpm --filter @subify/server exec wrangler secret put MASTER_SECRET`, never in `wrangler.toml`: until it is set, the server refuses to serve. On Node, `MASTER_SECRET` in `.env` works too; without it, the server generates one at its first start, in the file `SECRET_PATH`, and says so once.

Keep a copy of the secret offline, apart from the database: without it the catalog can't be read, and with both anyone can read it. Changing it makes the catalog unreadable; devices then add their channels back on their own.

The server rewrites its whole catalog every 10 minutes or more (the pass). Changes wait for the next pass, and the new-channel budgets are counted in memory on Node and in a Durable Object on Workers, which `wrangler.toml` declares (`COORDINATOR`): a restart starts the budgets over. The thumbnails take about 600 MB of database at first (30 days of 24 KB thumbnails), more as the catalog grows.

Default: generated on Node, none on Workers.

### `WIKIDATA_USER_AGENT`

**What it is for.** When someone types a channel's name rather than its @handle or link, the app first looks for it in a dictionary of about 157,000 YouTube channels that Wikidata names, which it downloads whole (about 7 MB) and searches on the device. The server never learns a name the dictionary knows. The server builds that dictionary from Wikidata, and Wikimedia asks every automated client to name itself and give a way to reach its operator: this variable is that name and contact, sent to Wikidata only. Your server's other requests keep the generic User-Agent.

**Without it**, the server never contacts Wikidata and has no dictionary. Adding a channel by its @handle or its link works the same; a name is only tried as the @handles it likely gives, which the server reads online, so the server learns it, and a channel whose handle doesn't follow its name can't be found by name.

Set it to your instance's name and a contact you read, for example `SubifyBot/1.0 (https://videos.example.org; you@example.org) feed-reader`. The official instance uses `SubifyBot/1.0 (https://subify.tv) feed-reader`.

Default: empty, no dictionary.

### `WIKIDATA_REFRESH_DAYS`

Days between two downloads of the dictionary. A download reads one slice a minute, 64 in all, about an hour, and writes them to the database outside the encrypted catalog's pass (the dictionary is public data).

Default: 7.

### `SEARCH_SOURCES`

Where a channel's name is looked for, comma-separated. `wikidata` is the dictionary above (it also needs `WIKIDATA_USER_AGENT`). `invidious` and `piped` let your server search a name on public Invidious and Piped instances when nothing on the device found it: the server sends the name to one instance (never the device), checks each result against the channel's own feed on YouTube, and shows at most 5. `none` leaves only @handles and links.

Turn `invidious` and `piped` on knowingly. These are third-party services that read YouTube in ways that may break its terms, which Subify itself doesn't; their operators ask to limit automated traffic, and most public instances keep their API closed. An instance sees the names searched from your server, mixed with decoys (below), never who searched them. An instance that answers 401, 403, 429 or a challenge page instead of its API is left alone for a day. Each search counts in `ONLINE_LOOKUPS_PER_MINUTE`.

Default: `wikidata`. The official instance turns on all three. Example: `SEARCH_SOURCES=wikidata,invidious,piped`.

### `INVIDIOUS_INSTANCES`, `PIPED_INSTANCES`

The instances to search, comma-separated host names or https addresses, for example `INVIDIOUS_INSTANCES=invidious.example.org` for one you run yourself. Left empty, the server reads the projects' official lists once a day (`api.invidious.io` and `piped-instances.kavin.rocks`) and keeps the instances with their API open: for Invidious, those the list marks with an open API and up; for Piped, those up to date and up 90 % of the last week. A real search goes to one of the three that answered best lately, drawn at random by their scores, which live in memory only and start over at a restart.

Default: empty, the official lists.

### `SEARCH_DECOYS_PER_HOUR`

Decoy searches sent to the instances per hour, on average, at random times, besides the 2 sent to other instances with each real search. They are names from the dictionary and common words, never anything from your catalog, so that an instance can't tell a real search from the others. More decoys hide real searches better, and load instances that ask to limit robots. Once a day the server logs the share of searches an instance sees that are real (`Search blurring`), the number the decoys bring down.

Default: 2. 0 keeps only the decoys sent with each search.

### Node only

| Variable | What it does | Default |
|---|---|---|
| `PORT` | The port the server listens on. | `8787` |
| `WEB_DIST` | The folder of the built app, served on the same origin as the API: `../web/dist` from `apps/server`. Empty serves the API only, as in development, where Vite serves the app. | empty |
| `DATABASE_PATH` | The SQLite file, created with its folder if needed. | `data/subify.sqlite` |
| `MIGRATIONS_DIR` | Where the migrations are. Only needed if you move the built server away from the repository. | `apps/server/migrations` |
| `SMTP_URL` | The mail server the contact form sends through (see [`MESSAGES_TO`](#messages_to-messages_from-smtp_url)). A secret. | empty |
| `SECRET_PATH` | Where the master secret is generated and read when `MASTER_SECRET` isn't set (mode 0600). A server that finds the file but can't read it refuses to start rather than make a new one. | `subify.secret`, next to the database |
