---
description: Deploy this Quick app and print its live URL
---

Deploy the current Quick project to the sandbox.

Site name: use "$ARGUMENTS" if the user gave one. Otherwise do NOT invent a name
and do NOT copy one out of these docs — omit it and let the CLI resolve the name
for this folder (the same team/repo/username-prefixed name `quick init`
suggested). Any literal name here would be shared by every project scaffolded
from this template, so deploying to it clobbers someone else's site.

Check whether this repo is wired for auto-deploy — look for
`.github/workflows/workflows-quick.deploy.yml`:

- **If it exists** (e.g. the repo was made with `quick init --github`), the
  canonical deploy is to commit and push to `main`; the workflow publishes the
  site automatically as `github:<org>/<repo>`. Prefer that:
  `git add -A && git commit -m "…" && git push`. Only run `quick deploy` locally
  for a throwaway preview — it deploys under your own identity and will clash
  with the CI deploy's ownership of the site.
- **Otherwise**, run `npm run deploy` (set `QUICK_SITE` only if the user gave a
  name). Do NOT run `quick deploy .` in this project: on Windows it also uploads
  `.git/`, `.claude/` and tooling. The script publishes only the files listed in
  `INCLUDE` in `scripts/deploy.mjs`, and then checks that the site holds nothing
  else. If you add a new top-level asset, add it to `INCLUDE`.

If what you were handed is a `.zip` rather than a folder, extract it and deploy
the extracted directory (`unzip site.zip -d site && quick deploy site`) —
`quick deploy` takes a directory only, and will say so if given an archive.

If a deploy prompts to confirm overwriting a site someone else deployed last,
STOP and ask the user before confirming. On success, share the live URL, which
`quick deploy` prints on the last line (`quick url` reprints it).
