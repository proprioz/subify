# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub: the repository's **Security** tab, then **Report a vulnerability**. Say what you found, how to reproduce it, and what it affects (the app, the server, or the official instance at https://subify.tv). You'll get an answer as soon as possible, and credit if you wish once it is fixed.

## How Subify protects its users

- **Nothing to steal about users.** No accounts, no identifiers, no cookies. The server stores no list of anyone's channels, everything it stores about channels is encrypted, and its logs never let anyone identify the channels someone follows (see the principles in [CONTRIBUTING.md](CONTRIBUTING.md)).
- **The catalog doesn't point at anyone.** The official instance seeds its catalog with channels on its own (a self-hosted server can turn this on), through the same code as a user's channel, so a channel's presence doesn't show that someone follows it ([docs/FEATURES.md](docs/FEATURES.md), D15).
- **Strict inputs.** Every API request from the app is checked against a strict schema; unknown fields are refused; bodies are size-limited. The WebSub callback accepts only known parameters and signed notifications. Links are parsed by strict patterns, and the server never requests a URL a user sent: only URLs it builds or reads from the platform, on a closed list of hosts, with a timeout and a size cap.
- **Bound queries.** Every SQL value is bound; only constants written in the code reach the SQL as is.
- **Sealed backups.** Argon2id and XChaCha20-Poly1305, with the key settings authenticated and capped on reading; the password is never stored.
- **The browser enforces the rules.** A Content Security Policy keeps the app on its own origin and lets it show only images it already holds.
- **Abuse limits.** Budgets shared by all users cap how many new channels enter the catalog; the official instance also limits request rates at its edge, without the app ever seeing IP addresses.
- **Supply chain.** Dependencies only after 7 days (exact-version exceptions only for urgent security fixes, each with a removal date), install scripts only for an allow-list, pinned GitHub Actions, Dependabot and a weekly audit.
