# Quick app

This folder is a **Quick** app: static front-end files that deploy to Mozilla's
Quick platform and get a live backend for free — persistent data, a database,
realtime, AI, file uploads, BigQuery, Prometheus metrics, and Slack notifications
— all via a client SDK, behind SSO.

## Build
**This folder is the site, served from its top level.** Create and edit
`index.html` (and its assets) here at the root — that's the whole app; don't nest
it in a subfolder. Add `<script src="/quick.js"></script>` to your HTML and use the
global `quick` object. No server, no auth code, no API keys. Everything is
same-origin and authenticated by the user's Mozilla SSO session automatically.

Core APIs (full reference + snippets in `.claude/skills/quick/SKILL.md`):
- `quick.me()` — the signed-in user
- `quick.data` — key/value store with **atomic** `incr`/`append`/`update` and live `subscribe`
- `quick.db.collection(name)` — document CRUD + live `subscribe({onCreate,onUpdate,onDelete})`
- `quick.ai.ask / chat / image` — Claude (pick a model per call) + Gemini, no key needed
- `quick.socket()` — realtime room (presence, cursors, broadcast) for multiplayer
- `quick.notify.mention` / `.channel` — Slack-DM a person, or post to a channel
  the app has been invited to
- `quick.files.upload / list / delete` — file storage
- `quick.query(sql)` — read-only BigQuery (public data + Mozilla's `mozdata` warehouse)
- `quick.metrics` — read-only PromQL over Mozilla's Prometheus (the scopes Grafana reads), with `frame()` for charting

## Deploy
If this repo has `.github/workflows/workflows-quick.deploy.yml` (e.g. from
`quick init --github`), commit and push to `main` — the workflow deploys it
automatically as `github:<org>/<repo>`; deploying locally with `quick deploy`
uses a different identity and clashes with it. Otherwise deploy locally:
    quick deploy .                     # resolves this folder's site name, prints the live URL
Append a name only to override it (`quick deploy . other-name`). Also: `quick list`,
plus `quick url` / `quick open` / `quick rm`, which default to that same name.

## Conventions
- **Name sites `<team-or-product>-<feature>`** (e.g. `ads-onboarding-poll`), or
  `<username>-<feature>` for personal sites, so the shared, open namespace stays
  searchable and hard to clobber; `lib-*` is reserved for shared libraries other
  sites embed. `quick init` auto-applies this prefix (`$QUICK_TEAM`, else your
  gcloud username), using the repo name as the base inside a Git repo — and a bare
  `quick deploy .` / `url` / `open` / `rm` resolves that identical name, so prefer
  the nameless form over retyping it. Names are lowercased, non-alphanumerics
  become `-` (`team_feature` → `team-feature`), max 63 chars.
  Exception: a repo from an allow-listed org — a `mozilla` org or
  `saml-test-integrations2` — may use the bare repo name (already unique, owned,
  and allow-listed); `quick init` skips the prefix there unless `$QUICK_TEAM` is
  set (→ `<team>-<repo>`).
- **Shared libraries live in `mozilla/quick-libs`,** one folder per library, each
  served from `lib-<name>` and embedded with one `<script>` tag pinned to a major
  version. When starting a site or adding a feature such as comments, look there
  first for a library that already provides it (`gh repo view mozilla/quick-libs`,
  or without `gh` `gcloud storage ls 'gs://moz-fx-quick-prod-sites/lib-*/llms.txt'`):
  a library can constrain routing and markup, so adopting one late can mean a
  rework. A new library is best published from there rather than deployed by
  hand. Details under "Shared libraries" in `.claude/skills/quick/SKILL.md`.
- Data/files/realtime are scoped per-site (per hostname).
- **Auto-indexed by default:** every site is listed in the LLM-summarized
  directory at `https://index.quick.mozilla.cloud/`, generated from the page's own visible
  text (behind SSO). A clear `<title>` / `<meta name="description">` improves the
  summary. Opt out with `<meta name="quick-nav" content="off">` (also removes the
  "← Quick" pill).
- Save files as UTF-8 and keep `<meta charset="utf-8">` in your HTML (the starter
  has it) — otherwise emoji / curly quotes / accents render as mojibake.
- **One top-level site by default.** A single `index.html` at the root is a fine
  app; keep everything at the top level so it serves from the site root. Multiple
  sites from one repo is possible but not the default — deploy a subfolder as its
  own named site (`quick deploy ./other-site other-name`).
