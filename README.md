# Subify

Subify is an installable web app (PWA, iOS and Android first) to follow your favourite video creators, YouTube for now, without an account and without being tracked. You see the latest videos of the channels you chose, newest first, and nothing else: no recommendations, no content you didn't ask for.

Everything you follow stays on your device. A light server keeps a shared catalog of channels and their recent videos, so your device doesn't have to contact the platform itself. It keeps that catalog encrypted, never learns which channels a device follows when the catalog already has them, keeps nothing about who follows what, and anyone who would rather not trust it can host their own.

The official instance runs on https://subify.tv.

## Why Subify

- **Only what you chose.** No trending page, no recommendations: nothing you didn't ask for. For each channel, choose what you want to see: its videos, its Shorts, its lives. Keep some channels secret: they stay hidden until you unlock them. What's on your device is encrypted, and you can lock it with a password, Face ID or a fingerprint.
- **No account, no tracking.** Never a mandatory sign-in: no account, no email, no profile. The platform never learns which channels you follow. No ads, and nothing that studies your habits. The app never goes online on its own: only for what you are doing in it, and without sending anything that identifies you.
- **Sealring.** The privacy system designed for Subify, named after the seal ring once used to close letters: whoever carried the letter couldn't read it. Each channel stays sealed at all times, and the server can't open it; every few minutes, each seal is swapped for a fresh one, so even copies of its data taken at different times tell nothing about the channels. If the server sent each device its own news, it would know what each device follows: so it posts everyone's news on a ring (a circle) of places, like the hand of a clock going round. Every few minutes it fills the next place with a bundle of sealed envelopes, always the same size, real news mixed with empty ones; once round, each new bundle replaces the oldest, so the ring never grows and gives nothing away. Your device picks up the bundles it missed and opens only the envelopes meant for it. Your device finds your channels without naming them, and the server can also add channels at random, the way a real person would, so whoever runs it can't tell which channels users added.
- **Open source.** You don't have to trust us. The code is public, under the AGPL-3.0 (see [LICENSE](LICENSE)): anyone can audit it, and run the whole system on their own server, a Raspberry Pi, or a NAS (coming soon).
- **Watch on YouTube.** Subify doesn't play videos: copy a link, or open it in YouTube and watch it there, as usual.
- **Support the creators you love.** Subify shows no ads, so creators earn nothing from your visits here. Share their videos, support them directly through memberships or donations, or buy their merch.

The app's Privacy page, in Settings, says exactly who sees what.

## Privacy, in short

- No account, no device id, no cookie, no token: requests carry nothing that identifies you. Your list of channels stays on your device, and nothing records what you open.
- What is yours (channels, their videos, your choices, your settings) stays on your device, and nothing sends it anywhere to be analysed; your password, Face ID or fingerprint never leave it. That data is always encrypted. By default, the app keeps the key on the device and opens without asking: the data is then as safe as the device's own lock, no more. To lock the app, choose a password, Face ID or a fingerprint (on devices that support them), and when the app asks for it again: each time it opens, when you come back to it, or after a few minutes unused. Lose what unlocks it and the data can't be opened again; a backup lets you start over. Hidden channels stay hidden until you unlock them.
- The app never goes online on its own, never at launch or on a timer: only for what you are doing in it, such as adding a channel, refreshing or restoring a backup. Its requests carry nothing that identifies your device or ties one request to another. The server then sees a few things, and is built not to keep them, nor any log that would give clues about what you follow.
- When you refresh, your device downloads the news of many channels at once and keeps only its own: the server doesn't learn which ones are yours. When you add a channel the server doesn't have yet, it sees that channel, but not who asked.
- Looking a channel up by its name starts on your device; then, if the server's operator turned them on, on Invidious or Piped, services run by others; and last on YouTube. These searches leave from the server, never from your device, and the server forgets them.
- The optional connection check lets the app first ask which country the server sees you from, for example to make sure your VPN is on; the server doesn't keep the answer.
- Everything the server stores about the channels people follow is encrypted.
- The server's logs never let anyone identify the channels someone follows or what the server holds. The platform the server runs on handles the network traffic like any host, your IP address included: use a VPN, or host your own server.
- Backups are always sealed with a password.
- Writing through the contact form sends your name, your address and your message to whoever runs the server, by email; the server keeps none of it.

## How Subify reads the platform

Subify reads the platform the way a feed reader does, and as little as it can:

- **Once per channel, for everyone.** The server follows each channel once, however many people follow it: reading feeds depends on the size of the catalog, never on the number of users or refreshes. Each new video's small thumbnail is read once, when the video arrives.
- **Notified rather than polling.** New videos arrive through WebSub notifications, which the platform sends itself. Polling stays as a slower safety net (every 4 to 24 hours per channel while notifications work, weekly for quiet channels), and backs off after errors.
- **Public data only.** The public RSS (Atom) feeds of channels, oEmbed, the WebSub hub, public avatar and thumbnail images, and a channel's public page, read when the channel enters the catalog for its id, name and avatar. No account, no API key, no private API. Outside the platform, Wikidata's public query service, and Invidious and Piped when the server's admin turns them on.
- **Videos stay on the platform.** Subify never plays, downloads or stores videos and never touches ads: every video opens on YouTube.

The rules the code follows are in [CONTRIBUTING.md](CONTRIBUTING.md); how to report a security issue is in [SECURITY.md](SECURITY.md).

## Host your own

The same code runs on Node (SQLite) and on Cloudflare Workers (D1, Workers Paid plan). The app only talks to the server that served it, so installing it from your own server is all it takes to use your own catalog.

[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) explains how to build, configure, run and update a server, with an example for each variable. One thing to know first: a personal instance's catalog is close to its owner's list of channels, so keep it private, behind a VPN or your reverse proxy's authentication.

## Development

Requires Node and pnpm.

```sh
pnpm install
pnpm dev     # Node server on :8787 with hot reload, Vite on :5173 proxying /api
```

Or `docker compose up`, then open http://localhost:5173.

To fill the development catalog from recorded feeds, without any request online: `pnpm --filter @subify/server dev:seed`, with the dev server stopped. Once started, the dev server polls these channels on YouTube as usual.

How the code is organised, its conventions and the other commands are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[GNU Affero General Public License v3.0 or later](LICENSE). If you run a modified Subify server for others, offer them its source code.
