---
name: quick
description: Build and deploy Quick apps — real-time collaborative web apps on Mozilla's Quick platform via the quick.js SDK and the `quick` CLI. Use when creating a site with live data, a database, AI, image generation, file uploads, BigQuery, Slack notifications/@mentions, or multiplayer/WebSocket features, when adding a shared library to a site, or when deploying one.
---

# Quick

Quick turns a folder of static files into a live app, served from its top level:
the `index.html` at the folder root is the site's home page. You write **only
front-end HTML/CSS/JS** — no server, no auth code, no API keys, no database setup.
Every site is served behind Mozilla SSO, and a client SDK at `/quick.js` gives you
a persistent datastore, a database, realtime, AI, file uploads, BigQuery and Slack
notifications — all same-origin and authenticated automatically.

## The one thing to remember

Add this to any page, then use the global `quick` object:

    <script src="/quick.js"></script>

No init, no config, no keys. Calls are authed by the user's SSO session and
scoped to *this* site automatically.

## APIs

### Who am I (`quick.me`), who is anyone (`quick.identity`)
    const me = await quick.me();
    // { email, person, as_of }. `email` is the signed-in identity; `person` is
    // their staff-directory record (name, title, team, manager_email, timezone,
    // office_location, slack_id, github_username, bugzilla_email, ldap_groups,
    // mozilliansorg_groups, ...) or null for a non-staff account, so always
    // handle null.

    const p     = await quick.identity.get('wdawson');            // email | LDAP name | GitHub login; null if unknown
    const hits  = await quick.identity.search({ q: 'dawson', limit: 20 });  // { results, total }
    const who   = await quick.identity.search({ group: 'looker_dev_access' }); // exact group name
    const near  = await quick.identity.search({ timezone: 'America/Los_Angeles' }); // exact IANA zone
    const kids  = await quick.identity.reports(p.email);          // direct reports; { depth: 'all' } for the subtree
    const chain = await quick.identity.chain(p.email);            // [manager, ..., root]
    const teams = await quick.identity.teams();                   // [{ team, manager_email, count }]
    const all   = await quick.identity.all();                     // { people, as_of }: the whole directory

Staff use several email domains, so never gate on a suffix like `@mozilla.com`;
check `person` instead. This is a directory, **not authorization**: every Quick
site is open to all staff, and a client-side check on `person.team` is bypassed
by opening devtools.

The same data is in BigQuery as `mozdata.mozcloud.person_api_staff_members`, for
when you want SQL over it (joins with other tables, aggregates) via `quick.query`
below. The API is the snapshot the platform refreshes on an interval; the table is
live.

### Key/value store (`quick.data`) — counters, settings, small shared state
    await quick.data.set('theme', 'dark');
    const t = await quick.data.get('theme');       // value | null
    await quick.data.delete('theme');

    // ATOMIC — use these instead of get()+set() to avoid lost updates:
    await quick.data.incr('votes');                // +1  -> new number
    await quick.data.incr('score', 5);             // +5
    await quick.data.incr('tally', 1, 'pizza');    // increment field 'pizza' of an object
    await quick.data.append('log', { msg: 'hi' }); // push to an array -> new array
    await quick.data.update('cfg', c => ({ ...c, n: (c?.n || 0) + 1 })); // optimistic RMW

    // LIVE: cb fires on every change (server-sent events). Returns unsubscribe.
    const off = quick.data.subscribe('votes', v => render(v));

**Keys are alphanumeric + `_`.** Punctuation is rejected with `bad key`, and it
**throws** rather than returning `null` — so the obvious key for per-user state, an
email, blows up whatever called it:

    await quick.data.get(`prefs:${email}`);                        // throws: bad key
    await quick.data.get(`prefs_${email.replace(/[^a-z0-9]+/g, '_')}`);   // fine

Values are shared by everyone on the site, so keying by identity is the normal
case — which is why this is the first thing you hit. A key that was never written
is a plain `404` that `get()` maps to `null`; that one isn't an error.

### Database (`quick.db`) — collections of documents (mini Firestore)
    const posts = quick.db.collection('posts');
    const p = await posts.create({ title: 'Hello', done: false });  // -> { id, ... }
    await posts.get(p.id);
    await posts.list();                       // [ { id, ... }, ... ]
    await posts.update(p.id, { done: true }); // partial patch
    await posts.replace(p.id, { ... });       // full replace
    await posts.delete(p.id);

    // LIVE: replays existing docs as onCreate, then streams changes. Race-free
    // (each create is its own row) — prefer this over quick.data for lists.
    const off = posts.subscribe({
      onCreate: doc => add(doc),
      onUpdate: doc => patch(doc),
      onDelete: id  => remove(id),
    });

### AI (`quick.ai`) — Claude + Gemini, no key needed
    const text  = await quick.ai.ask('Summarize these notes: ...');
    const text2 = await quick.ai.chat([                     // multi-turn
      { role: 'user', content: 'Plan a team lunch' },
    ]);
    // model: 'opus' (default) | 'sonnet' (faster) | 'haiku' (fastest, cheapest) |
    // 'opus-4-8' (the previous Opus). A full id works too ('claude-opus-5');
    // anything else is a 400 listing what this deployment allows.
    const label = await quick.ai.ask('Positive or negative? ...', { model: 'haiku' });
    // thinking: true reasons before replying — better on hard asks, slower, and the
    // reasoning spends the same budget as the reply, so max_tokens then defaults to
    // 4096 instead of 1024 (cap 8192 either way). Leave it off for short answers.
    const plan = await quick.ai.ask('Design a schema for ...', { thinking: true });
    const dataUrl = await quick.ai.image('a cat riding a bike, watercolor');
    // dataUrl is a data:image/...;base64,... string -> <img src={dataUrl}>
    // Pass `images` (max 4) to EDIT or COMPOSE instead of generating from scratch.
    // Each is a File/Blob, a png/jpeg/webp data: URL, or a same-origin path — an
    // asset you deployed, or the url quick.files.upload() returned:
    const hatted = await quick.ai.image(
      'Put the hat from image 1 on the person in image 2, matching their head angle.',
      { images: ['/captain.png', fileInput.files[0]] });
    // agent(task) -> { text, trace }: Claude WITH governed MCP tools (via Runlayer),
    // acting on-behalf-of the signed-in staff member (403 if not in the directory).
    // Takes { model } too; it always reasons, so don't pass `thinking`.
    const res = await quick.ai.agent('Summarize my open Jira tickets');

### Realtime / multiplayer (`quick.socket`) — presence, cursors, live events
    const socket = await quick.socket();      // connects same-origin, into this site's room
    socket.on('hello',   ({ user }) => {});   // you connected; `user` is the SSO email
    socket.on('message', ({ from, user, data }) => draw(user, data)); // someone broadcast
    socket.on('left',    ({ from }) => removeCursor(from));           // someone disconnected
    // send to everyone else in this site (relayed back to them as 'message'):
    document.onmousemove = e => socket.emit('broadcast', { x: e.clientX, y: e.clientY });

### Notifications (`quick.notify`) — Slack-DM a person
    await quick.notify.mention({
      to: ['someone@mozilla.com'],        // or one string; max 10 per call
      text: 'take a look at the second paragraph',
      link: location.href,                // optional, must point back into Quick
      kind: 'mention',                    // or 'reply' / 'comment' for the DM's first line
    });
    // -> { sent: ['someone@mozilla.com'], failed: [] }

Sends each person a Slack DM reading "*you* mentioned you on `<site>`", your text
quoted underneath, the link on its own line. The sender and the site are taken
from your SSO session and the hostname, never from what you pass, so a message
always says who really sent it and from where. There is no way to send as anyone
but yourself.

**Check `failed`, don't assume a 200 reached everyone.** Delivery is per address:
someone with no Slack account comes back in `failed` with Slack's own
`users_not_found` while the rest are already delivered. Naming yourself delivers
to yourself, so drop the author from your own list if you don't want that.
Recipients must be active staff (any Mozilla email domain), and `link` must be a URL on this deployment:
an off-site link is a 400, since the DM carries a trusted bot's name and cannot
be an open redirect. Rate limit is 20 recipients per minute per person per site,
then a 429 with `Retry-After`.

To post to a channel instead of a person:

    await quick.notify.channel('#team-channel', 'nightly import finished',
                               { link: location.href });
    await quick.notify.channel('C01234ABCDE', 'same, by id');

**Somebody has to `/invite` the app to that channel first**, or the call fails
with `not_in_channel`. That invite is the only authorization; there is no
allowlist. Private channels need the id, since Slack only resolves public names.

Add `?dry_run=1` to build the message and see who it would reach without sending:

    await fetch('/api/notify/mention?dry_run=1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'someone@mozilla.com', text: 'test' }),
    }).then(r => r.json());   // -> { dry_run: true, to: [...], text: '...' }

**To offer an @-autocomplete,** use the staff directory the platform already holds:

    const { people } = await quick.identity.all();      // the whole directory, one call
    // or per keystroke: quick.identity.search({ q, limit: 8 })

Fetch `all()` once on first focus and filter in memory; that is what makes it feel
like an autocomplete. Each record carries `ldap_user`, `name`, `title`, `team`,
`github_username`, `slack_handle` and both group lists. Show `title` and `team` in
each row: a name alone is ambiguous exactly when it matters. `ldap_user` is what
people type, `github_username` is a good second key, and `username` is a
Mozillians profile slug most people never see, so don't match on it. Everyone in
the directory is active staff, so there is nothing to filter on.

### File uploads (`quick.files`)
    const { url } = await quick.files.upload(fileInput.files[0]); // -> same-origin url
    await quick.files.list();     // [ { url, name, size, type }, ... ]
    await quick.files.delete(url);

### BigQuery (`quick.query`) — read-only SELECT / WITH (query the warehouse)
    const res = await quick.query(
      'SELECT col, COUNT(*) c FROM `mozdata.dataset.table` GROUP BY 1');
    // -> { fields:  ['col', 'c'],           // column names
    //      rows:    [['a', 12], ...],       // POSITIONAL arrays, not objects
    //      total_rows: 2, truncated: false, total_bytes_processed: '1234' }
    const objs = quick.rows(res);   // -> [{ col: 'a', c: 12 }, ...]
    // quick.rows() zips rows against fields AND unwraps the raw [{v:...}] that
    // BigQuery leaves around REPEATED (array) columns. res.rows[0].col is
    // undefined — go through quick.rows() unless you want the positional form.
    // Reads public data (`bigquery-public-data.*`), this project's own datasets,
    // and Mozilla's warehouse in the `mozdata` project — mozilla-confidential
    // access is enabled, so reference Mozilla data as `mozdata.<dataset>.<table>`.

**A result can come back short.** One response carries at most 10 MB, so how many
rows you get depends on how wide they are — narrow rows might all arrive, wide
ones won't. `total_rows` is how many the query actually matched and **`truncated`
is true when you got fewer** — check it on any row-level query, or you'll compute
on a partial answer that looks complete. Aggregate in SQL where you can;
otherwise page with a stable unique sort key:

    const all = [];
    let offset = 0, stride = null;
    for (;;) {
      const res = await quick.query(
        `SELECT name, email FROM ${VIEW} ORDER BY email LIMIT 1000 OFFSET ${offset}`);
      const page = quick.rows(res);
      all.push(...page);
      if (stride === null) stride = page.length;   // what a full page really is
      if (!page.length || page.length < stride) break;
      offset += page.length;
    }
    // Measure the stride from the first page instead of assuming your LIMIT was
    // honoured — if the 10 MB ceiling trims a page, a hardcoded stride would skip
    // the rows it cut. The sort key must be unique and non-null, or OFFSET paging
    // can drop or repeat rows between pages.

A query that runs past 30s fails with **504** rather than returning nothing, so an
empty `rows` always means "matched nothing", never "gave up".

### Writable analytics (`quick.bq`) — your own per-site tables you can append to
    await quick.bq.insert('events', { kind: 'click', path: location.pathname });
    await quick.bq.insert('events', [ { kind: 'a' }, { kind: 'b' } ]);  // batch
    const recent = await quick.bq.rows('events', { limit: 50 }); // [{_id,_at,data}], newest first
    const tables = await quick.bq.tables();                      // ['events', ...]
    // analytical SQL over your OWN tables — reference them as {table}:
    const { rows: byKind } = await quick.bq.query(
      'SELECT STRING(data.kind) AS kind, COUNT(*) AS n FROM {events} GROUP BY kind ORDER BY n DESC');
    // Columns: _id, _at (TIMESTAMP), data (JSON — use data.field or JSON_VALUE).
    // Rows are arbitrary JSON (stored in a JSON column); tables auto-create on
    // first insert and are isolated per site. Use quick.bq for data your app
    // WRITES; use quick.query for read-only queries of existing warehouse datasets.

### Metrics (`quick.metrics`) — read-only PromQL over Mozilla's Prometheus
Same five metrics scopes Grafana/Yardstick reads, under the same names, so a query
that works there works here. Read-only; nothing is per-site.

**A query copied from Grafana runs as-is.** Grafana's interval variables
(`$__rate_interval`, `$__interval`, `$__range`) are expanded server-side from the
step this API derives, and `'now-6h'` is accepted alongside `'-6h'`. What you do
have to check is the **scope**: Yardstick names its datasources `gcp-<scope>`, so a
panel on `gcp-v1-prod` needs `{ scope: 'v1-prod' }` here. Get that wrong and the
query doesn't error, it matches nothing — an empty chart that looks like a bug in
your code.

    // instant value
    const res = await quick.metrics.query('sum by (cluster) (up)');
    // -> { resultType:'vector', result:[{ metric:{cluster:'a'}, value:[sec,'12'] }], ... }

    // over time. start/end take '-6h' | 'now-6h' | 'now' | a Date | ms | ISO.
    // Default: last hour.
    // OMIT step and a sensible one is derived from the range — this is the one-liner.
    const res = await quick.metrics.range('sum(up)', { start: '-6h' });
    // The window snaps to step boundaries (as Grafana does), so res.start/end/step
    // tell you what you actually got. That's why polling is cheap and why the axis
    // doesn't shimmer between refreshes.
    // res.substituted says what any $__ variables were expanded to.

    // MANY QUERIES AT ONCE — the shape a dashboard actually has. One round trip,
    // answers in the order asked, and items are independent: one that fails comes
    // back as { error, detail, status } in its slot instead of sinking the rest.
    const [rate, p99] = await quick.metrics.batch([
      { query: 'sum(rate(x[5m]))', start: '-6h' },   // start/end => a range query
      { query: 'sum(y)' },                           // neither    => instant
    ]);
    // Refresh a whole dashboard with one call rather than one per panel. It saves
    // round trips, not budget: a sub-query that misses the cache still costs a
    // query, because it still costs an upstream call.

    // frame() is the chart-ready shape (the quick.rows() of this API):
    const { times, series } = quick.metrics.frame(res);
    // times:  [msTs, ...]                      one shared axis
    // series: [{ labels, name, values }]       values aligned to times, null for gaps
    // Prometheus matrices are RAGGED — each series has its own timestamps, with
    // holes where a target went stale — so plot frame(), not res.result, or your
    // series will be misaligned.

    // discovery
    await quick.metrics.scopes();   // [{name, project}] + which is default
    await quick.metrics.names({ match: '{__name__=~"run_.*"}' });  // metric catalog
    await quick.metrics.labels();                     // what you can group by
    await quick.metrics.values('job', { match: 'up' });
    await quick.metrics.list('up');                   // label sets matching a selector
    await quick.metrics.metadata('up');               // type/help/unit

    // scope: per call, or once for the page
    await quick.metrics.query('sum(up)', { scope: 'v2-nonprod' });
    quick.metrics.scope('v1-prod');
    // 'v2-prod' (default) | 'v2-nonprod' | 'v1-prod' | 'v1-nonprod' | 'mgmt-prod'

**GCP system metrics are in here too**, not just GKE exporters — so you can chart
a service that exports nothing. They're named `service_googleapis_com:metric`:

    // Quick's own request rate, by response class
    await quick.metrics.range(
      'sum by (response_code_class) (rate(run_googleapis_com:request_count{' +
      'project_id="moz-fx-quick-prod"}[5m]))', { start: '-6h' });

Two things will break your first panel if you don't know them:

- **`monitored_resource`.** A system metric that exists on several resource types
  400s until you disambiguate: add `monitored_resource="cloud_run_revision"`.
  `run_googleapis_com:request_count` doesn't need it;
  `run_googleapis_com:container_memory_utilizations`,
  `run_googleapis_com:container_cpu_utilizations` and
  `run_googleapis_com:container_instance_count` all do. Write these names out in
  full — a bare `container_cpu_utilizations` isn't a metric name at all, so it
  matches nothing and returns an empty result instead of the 400 you're expecting,
  which sends you hunting for the wrong problem.
- **Distributions** arrive as `_sum` / `_count` / `_bucket`. A mean is
  `rate(x_sum[6h]) / rate(x_count[6h])`; a percentile is
  `histogram_quantile(0.99, sum by (le) (rate(x_bucket[6h])))`.

Limits, and how they fail: **1500 points per series** (an explicit `step` finer
than that is a 400 telling you the minimum — it is never silently coarsened);
**500 series** (beyond that you get the first 500 and `truncated: true`);
**32 MiB** per answer (a 413 telling you to `sum by (...)`); **60 queries/min per
site** (429). A query past 30s is a 504, so an empty `result` always means
"matched nothing", never "gave up". `/rules` and `/alerts` don't exist upstream,
so **alert panels aren't possible** — chart the metrics instead.

Discovery calls return at most **2000 entries** with `truncated: true`, while
`count` reports what really matched — worth checking, because selectors match more
than you'd guess (`match: 'up'` is ~29k label sets on `v2-prod`, and the whole
catalog is ~31k names). Narrow with `match` rather than paging.

Results are cached for 10s server-side, so **extra viewers of the same dashboard
are nearly free — extra panels are not.** The budget is spent per distinct query
per 10s window, so the panel count is what to watch: 12 panels refreshing every
10s is 72/min and over the limit on its own, no matter who's watching. Budget it
as `panels × (60 / refresh_seconds) ≤ 60`, which at a 60s refresh is 60 panels but
at 10s is 10. A dashboard wants a refresh of 60s or slower, and panels that don't
refresh while scrolled offscreen. Prefer a coarse `step` and `sum by (...)` over
pulling raw series into the page.

Don't guess at how much of that is left — **every answer reports it**:

    const res = await quick.metrics.range('sum(up)', { start: '-6h' });
    res.budget          // -> { limit: 60, remaining: 53 }

The allowance is shared with everyone else viewing the site, so `remaining` can
fall without this page having spent anything. A 429 carries `budget.retry_after`
(seconds) as well, so back off by exactly that rather than a fixed guess.

## Shared libraries

Some features already exist as libraries other Quick sites embed with one script
tag; Figma-style comments (`lib-comments`) is the prototypical one. They live in
`mozilla/quick-libs`, one folder per library, each served from its own
`lib-<name>` site. When starting a site, or adding a feature such as comments to
one, look there first for a library that already provides it: a library can
constrain routing and markup, so adopting one late can mean a rework.

    gh repo view mozilla/quick-libs        # README lists every library and its pinned URL

Without `gh`, the sites bucket works as well, since every library publishes an
`llms.txt` there (the bucket name is in `quick env`; `quick list` reads the same
bucket):

    gcloud storage ls 'gs://moz-fx-quick-prod-sites/lib-*/llms.txt'        # what exists
    gcloud storage cat gs://moz-fx-quick-prod-sites/lib-comments/llms.txt   # how to use one

The sites themselves are behind SSO, so an agent cannot currently read a library's page
directly; the repo and the bucket are the two ways in.

**To use one,** read its `llms.txt`, then add the single tag it gives you. Pin
the major version rather than copying the file into the site: the major path is
how fixes reach every page that embeds it.

    gh api repos/mozilla/quick-libs/contents/comments/llms.txt --jq .content | base64 -d
    <script src="https://lib-comments.quick.mozilla.cloud/1/comments.js" defer></script>

The library runs in the host page's origin, so whatever it stores lands in the
host site's tenant, under the `lib_<name>_*` collections and keys its `llms.txt`
lists, which the host app is best off leaving alone.

**To publish one,** the convention is a folder in `mozilla/quick-libs` rather
than a hand-deployed `lib-*` site: the repo's workflow publishes every folder to
`lib-<folder>` with `/<major>/` and `/<version>/` paths generated from git, and
its README is where people look. Nothing enforces this; a hand-deployed `lib-*`
site works, it is just harder to find, and a name the repo also publishes gets
overwritten by its next run. Its `CONTRIBUTING.md` is the checklist.

## Deploy

From the project folder:

    quick deploy .                 # publish -> prints the live URL
    quick list                     # list your sites
    quick url                      # print this folder's site URL
    quick open                     # open it in a browser
    quick rm                       # delete it (files + data; always confirms)
    quick restore                  # undelete its files, up to 7 days after an rm

With no name, all of these resolve the same prefixed name for the current folder
(see "Naming your site"), so you rarely type one. Append a name to any of them to
target a different site: `quick deploy . other-name`.

`quick deploy` prints the live URL on its last line; `quick url` reprints it. Any
Mozilla staffer can open it.

**Archives:** `quick deploy` takes a directory, never a `.zip` — extract it first
(`unzip site.zip -d site && quick deploy site`, or `Expand-Archive` on Windows).
The upload card at `https://quick.mozilla.cloud` is the one path that *does*
unpack an archive, so the same zip lands differently depending on which you use.

**Auto-deploy repos:** if the repo has `.github/workflows/workflows-quick.deploy.yml`
(e.g. created with `quick init --github`), don't deploy locally — commit and push
to `main` and the workflow publishes it as `github:<org>/<repo>`. Running
`quick deploy` yourself deploys under a different identity and clobbers the CI
deploy's ownership marker.

## Naming your site

Every site lives in one flat, **open** namespace (`<name>.quick.mozilla.cloud`) that all
staff can see — and anyone can deploy to any name. **Prefix your site with your
team, product, or username** so related sites stay grouped, searchable, and hard
to clobber by accident:

    <team-or-product>-<feature>   ads-onboarding-poll, fxa-login-mockup, data-eng-dashboard
    <username>-<feature>          your Mozilla username, for personal/scratch sites: wdawson-lunch-vote
    lib-<name>                    shared libraries other sites embed (lib-comments); by convention published from mozilla/quick-libs

- Names are lowercased and non-alphanumerics collapse to `-` (so `team_feature`
  → `team-feature`, `product/thing` → `product-thing`), max 63 chars.
- A consistent prefix keeps `quick list` and the landing-page "Live sites" index
  scannable, and signals ownership in the shared-write model (any staffer *can*
  overwrite any name — a distinct prefix makes that far less likely).
- **`quick init` picks the prefix for you** before scaffolding — `$QUICK_TEAM` if
  set, else your Mozilla username (the local part of your gcloud login) — so folder
  `lunch-vote` scaffolds as `wdawson-lunch-vote`. **Inside a Git repo it uses the
  repo name as the base** (matching `quick gha`), so `$QUICK_TEAM=ads` in
  `mozilla/widgets` scaffolds `ads-widgets`. It's only a default; rename anytime.
- **It isn't an `init`-only feature.** `quick deploy .`, `quick url`, `quick open`,
  `quick rm` and `quick restore` all resolve the *same* name by the same rules when
  you don't pass one, so a folder keeps its site name without anything being written
  to disk. That makes the nameless form the one to prefer: it can't drift from what
  `init` chose, and it stays right if the folder is renamed or moved into a repo.
- **Exception — GitHub repos:** in a repo from an allow-listed org — a `mozilla`
  org (`mozilla` / `mozilla-*`) or `saml-test-integrations2` — the bare repo name
  is fine, no prefix needed. `<org>/<repo>` is already a unique, owned identifier,
  and the deploy is allow-listed (`gha.tf`) and provenance-tagged
  (`QUICK_DEPLOYED_BY: github:<org>/<repo>`). `quick gha` and `quick init` both
  default to the repo name there; set `$QUICK_TEAM` to prefix it anyway (→
  `<team>-<repo>`).

## Rules of thumb
- **Check `mozilla/quick-libs` before you design the page.**, via
  `gh` or the sites bucket. A library can constrain routing and markup, so
  adopting one late means rework.
- **One site = one app.** Data, files, and the realtime room are scoped to the
  site's hostname; different sites never see each other's data.
- **Counters/votes → `quick.data.incr`**, never get()+set() (that races).
- **Lists of things → `quick.db.collection` + `.subscribe`** (each create is its
  own row, so concurrent writers never clobber each other).
- **Live UI →** `.subscribe(...)` (SSE) for data/db; **`quick.socket()`** for
  ephemeral presence (cursors, typing, "who's here").
- Caps: `quick.data` values ≤ 256 KiB, **keys `[A-Za-z0-9_]`**, uploads ≤ 25 MiB.
- **Every site is auto-indexed.** It's listed in the directory at
  `https://index.quick.mozilla.cloud/`, which uses Claude to summarize, label, and
  categorize it from the page's own visible text — read via the auto-injected
  `quick-nav.js` (the same script that adds the "← Quick" back link), all behind
  SSO; nothing else is shared. A clear `<title>`, `<meta name="description">`,
  and headings make a better summary. Opt out of **both** the index and the back
  link with `<meta name="quick-nav" content="off">`.
- **Use UTF-8.** Save files as UTF-8 and keep `<meta charset="utf-8">` in your HTML
  (the starter has it) — without it, emoji, curly quotes, and accented characters
  render as mojibake.
- **Build at the top level.** Keep `index.html` and its assets at the folder root
  so the app serves from `https://<name>.quick.mozilla.cloud/`; a single top-level
  `index.html` with inline JS is the norm. Don't nest the app in a subfolder.
- **Client-side routing needs a `404.html`.** A single-page app that owns paths
  (`/report/42`, a Vue/React router in history mode) serves every route from one
  shell, but the site is a bucket of the files you uploaded — so clicking through
  from the root works while a deep link, a reload, or a shared link 404s. That
  asymmetry is the tell. Ship your shell under that exact name and unmatched
  paths fall back to it:

      cp index.html 404.html      # after your build, inside the deploy dir

  That copy is the whole fix: Quick rewrites to it internally, keeping the URL
  and the 200, so your router still sees the real path. **Don't port the GitHub
  Pages redirect shim** — the 404.html that encodes the path into a query string
  and bounces through index.html. That exists because GitHub serves 404.html as a
  true error page; here it would mangle URLs that already work. Opt-in: a site
  without the file keeps getting a plain 404, which is what a normal static site
  wants. Hash routing (`/#/report/42`) also works and needs no extra file, at the
  cost of the URLs.
- **Multiple sites from one repo is possible but not the default.** If you truly
  need it, deploy each subfolder as its own named site
  (`quick deploy ./other-site other-name`); otherwise the whole folder ships as
  one site and its subfolders are just paths under it.
