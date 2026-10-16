// Publishes only the site files to Quick, then checks the bucket holds nothing else.
// `quick deploy .` on Windows also uploads .git/, .claude/ and tooling, so it is not used here.
//
//   npm run deploy              deploy to the default site
//   npm run deploy -- --dry-run list what would be published
//   QUICK_SITE=other-name npm run deploy
import { cpSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = process.env.QUICK_SITE || 'slloyd-teamdatadashboard';
const INCLUDE = ['index.html', 'app.css', 'js'];   // the whole site; add new assets here
const QUICK_OWN = ['.quick-deployed-by'];          // written by quick itself
const dryRun = process.argv.includes('--dry-run');

const fail = msg => { console.error(`deploy: ${msg}`); process.exit(1); };
const walk = p => (statSync(p).isDirectory() ? readdirSync(p).flatMap(f => walk(join(p, f))) : [p]);
// gcloud is gcloud.cmd on Windows, which needs a shell; arguments here are fixed, not user input.
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });

for (const f of INCLUDE) if (!existsSync(join(ROOT, f))) fail(`missing ${f}`);
const files = INCLUDE.flatMap(f => walk(join(ROOT, f))).map(f => relative(ROOT, f).replaceAll('\\', '/')).sort();
console.log(`Site: ${SITE}\nFiles:\n${files.map(f => `  ${f}`).join('\n')}`);
if (dryRun) process.exit(0);

const stage = mkdtempSync(join(tmpdir(), 'tdd-deploy-'));
try {
  for (const f of INCLUDE) cpSync(join(ROOT, f), join(stage, f), { recursive: true });
  // --mirror removes remote files that are no longer part of the site.
  const dep = run('quick', ['deploy', stage, SITE, '--mirror'], { stdio: 'inherit' });
  if (dep.status !== 0) fail('quick deploy failed (if gcloud credentials expired, run `gcloud auth login` and retry)');
} finally {
  rmSync(stage, { recursive: true, force: true });
}

// Verify the bucket holds only the site files. --mirror does not delete dot-folders, so check explicitly.
const env = run('quick', ['env']);
const bucket = /sites bucket:\s*(\S+)/.exec(env.stdout || '')?.[1];
if (!bucket) fail('could not read the sites bucket from `quick env`; check the site contents by hand');
const ls = run('gcloud', ['storage', 'ls', '-r', `gs://${bucket}/${SITE}/**`]);
if (ls.status !== 0) fail(`could not list gs://${bucket}/${SITE}/: ${ls.stderr.trim()}`);
const prefix = `gs://${bucket}/${SITE}/`;
const remote = ls.stdout.split(/\r?\n/).filter(l => l.startsWith(prefix) && !l.endsWith('/')).map(l => l.slice(prefix.length));
const unexpected = remote.filter(f => !files.includes(f) && !QUICK_OWN.includes(f));
const missing = files.filter(f => !remote.includes(f));
if (missing.length) fail(`not found on the site after deploy: ${missing.join(', ')}`);
if (unexpected.length) {
  console.error(`deploy: the site also holds files that are not part of it:\n${unexpected.map(f => `  ${f}`).join('\n')}`);
  console.error(`Review them, then remove with: gcloud storage rm ${unexpected.map(f => `"${prefix}${f}"`).join(' ')}`);
  process.exit(1);
}
console.log(`Verified: the site holds only the ${files.length} site files.`);
