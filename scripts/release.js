#!/usr/bin/env node
/*
 * One-command release. Bumps the version, builds the Windows installer, commits
 * + tags + pushes, and publishes a GitHub Release with the installer attached.
 *
 *   npm run release          → patch bump (0.1.0 → 0.1.1)  — small fixes
 *   npm run release minor    → minor bump (0.1.0 → 0.2.0)  — new features
 *   npm run release major    → major bump (0.1.0 → 1.0.0)  — big milestones
 *
 * Run it on a CLEAN git tree (commit your changes first) — it only commits the
 * version bump itself, so nothing unrelated gets swept in.
 */
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const REPO = 'Boisteroux/mnm-tools';
const pkgPath = path.join(ROOT, 'package.json');

const run = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
const out = (cmd) => execSync(cmd, { cwd: ROOT }).toString().trim();
const step = (msg) => console.log('\n\x1b[1m\x1b[36m▸ ' + msg + '\x1b[0m');
const die = (msg) => { console.error('\n\x1b[31m✖ ' + msg + '\x1b[0m\n'); process.exit(1); };

// ── 0. Pre-flight ──────────────────────────────────────────────────────────
const bump = (process.argv[2] || 'patch').toLowerCase();
if (!['patch', 'minor', 'major'].includes(bump)) die(`Unknown bump "${bump}". Use: patch | minor | major`);

try { out('gh auth status'); } catch { die('GitHub CLI not logged in. Run:  gh auth login'); }
if (out('git status --porcelain')) die('You have uncommitted changes. Commit (or stash) them first, then re-run.');

// ── 1. Bump the version in package.json ──────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const prev = pkg.version;
const [maj, min, pat] = prev.split('.').map(Number);
const next = bump === 'major' ? `${maj + 1}.0.0` : bump === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
const tag = `v${next}`;
step(`Releasing ${prev} → ${next}  (${bump})`);
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// ── 2. Changelog: commit subjects since the last tag ─────────────────────────
let prevTag = '';
try { prevTag = out('git describe --tags --abbrev=0'); } catch {}
const range = prevTag ? `${prevTag}..HEAD` : '';
let changes = '';
try { changes = out(`git log ${range} --pretty=format:"- %s" --no-merges`); } catch {}
// Drop the release-bump line and the automated data-publish commits (auction prices,
// wiki enrich, play-data snapshots) that repeat hundreds of times and bury the real
// changes; de-dupe whatever's left so the notes are easy to read.
const NOISE = /^-\s+(Release v|Auto-publish auction prices|Auto-enrich traded items|Publish play data)/;
changes = [...new Set(changes.split('\n').filter((l) => l && !NOISE.test(l)))].join('\n') || '- Maintenance and fixes.';

// ── 3. Build the installer (stop the app first so files aren't locked) ───────
step('Building the Windows installer…');
try { execFileSync('taskkill', ['/IM', 'MnM Map.exe', '/F'], { stdio: 'ignore' }); } catch {}
try { execFileSync('taskkill', ['/IM', 'electron.exe', '/F'], { stdio: 'ignore' }); } catch {}
fs.rmSync(path.join(ROOT, 'dist', 'win-unpacked'), { recursive: true, force: true });
run('npx electron-builder --win --config.asar=false');

const installer = path.join(ROOT, 'dist', `MnM-Map-Setup-${next}.exe`);
if (!fs.existsSync(installer)) die(`Build finished but ${path.basename(installer)} is missing.`);

// ── 4. Commit the bump, tag it, push ─────────────────────────────────────────
step('Committing, tagging and pushing…');
run('git add package.json');
run(`git commit -m "Release ${tag}"`);
run(`git tag ${tag}`);
run('git push');
run('git push --tags');

// ── 5. Publish the GitHub Release with the installer attached ─────────────────
step('Publishing the GitHub Release…');
const notes = `Fan-made companion app for **Monsters & Memories**.

### What's new in ${tag}
${changes}

### Install
1. Download **MnM-Map-Setup-${next}.exe** below.
2. Double-click it. Windows SmartScreen shows a blue *“Windows protected your PC”* warning because the app isn't code-signed — click **More info → Run anyway**. (Normal for indie apps.)
3. It installs to your Start Menu as **MnM Map**.

It reads your own Monsters & Memories game files (read-only) to build your stats. 100% local — nothing is uploaded.`;
const notesFile = path.join(os.tmpdir(), `mnm-notes-${next}.md`);
fs.writeFileSync(notesFile, notes);
execFileSync('gh', ['release', 'create', tag, installer,
  '--repo', REPO, '--title', `MnM Map ${tag}`, '--notes-file', notesFile, '--latest'], { stdio: 'inherit' });
fs.rmSync(notesFile, { force: true });

const url = out(`gh release view ${tag} --repo ${REPO} --json url --jq .url`);
console.log(`\n\x1b[32m✔ Released ${tag}\x1b[0m`);
console.log(`  Installer:  ${path.basename(installer)}`);
console.log(`  Release:    ${url}\n`);
