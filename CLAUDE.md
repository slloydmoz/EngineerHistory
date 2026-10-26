@AGENTS.md

# Building in this folder

**This folder is the site — build at the top level.** Edit the existing
`index.html` (and add assets) here at the repo root; do **not** create a new
subfolder for the site.

**Deploy with `npm run deploy`, never `quick deploy .`.** On Windows, `quick deploy .`
also uploads `.git/`, `.claude/`, tests and tooling to the site. `scripts/deploy.mjs`
publishes only the files in its `INCLUDE` list (currently `index.html`, `app.css`,
`js/`), then fails if the site holds anything else. Add new site assets to `INCLUDE`.

The app (Engineer History) lives at `slloyd-engineerhistory`. `moved-site/` is a separate
one-page site deployed to each old name, `slloyd-teamdatadashboard` and `slloyd-teamhistory`,
that points people to the new address and lets them export settings saved under the old one
(`quick deploy ./moved-site <old-name> --mirror` for each). Redeploy both if the page changes.

Multiple sites from one repo is possible but not the default — only split content
into its own subfolder site if explicitly asked, then deploy it by name
(`quick deploy ./other-site other-name`).
