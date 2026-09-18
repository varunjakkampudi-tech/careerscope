#!/usr/bin/env node
/**
 * Back up this workspace's VS Code chat session so it can be carried to another
 * machine.
 *
 * Copilot chat is not in the repository. It lives in VS Code's workspaceStorage
 * under a folder named for a hash of the workspace path, which is why `git pull`
 * cannot bring it to a new machine: the macOS and Windows paths hash differently.
 *
 * Read the warnings this prints. In particular, VS Code does not necessarily
 * write `chatSessions/` until the window closes, so a backup taken mid-session
 * can contain a transcript of the conversation without containing a session VS
 * Code is able to reopen. Running it again after closing VS Code is what makes a
 * restore likely to work.
 *
 * Output goes to data/session-backups/, which is gitignored. It must stay that
 * way: a transcript contains whatever was discussed, including infrastructure
 * detail. Never commit one and never upload one somewhere public.
 *
 *   node scripts/backup-session.mjs            full backup
 *   node scripts/backup-session.mjs --slim     skip file-edit snapshots
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const slim = process.argv.includes('--slim');
const repo = process.cwd();

function userDirectory() {
  if (platform() === 'win32') return join(process.env.APPDATA ?? '', 'Code', 'User');
  if (platform() === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User');
  return join(homedir(), '.config', 'Code', 'User');
}

/**
 * Resolve which storage folders belong to this repository, by their recorded URI.
 *
 * There can be more than one: VS Code leaves a stale entry behind when a folder
 * is reopened in a way that produces a new hash, and the abandoned one still
 * claims the same path. Taking the first match silently backed up an empty
 * 0.05 MB folder instead of the real 94 MB one, so candidates are ranked by how
 * recently their state was written, and every candidate is recorded.
 */
function storageForWorkspace() {
  const root = join(userDirectory(), 'workspaceStorage');
  if (!existsSync(root)) return [];
  const wanted = resolve(repo).replace(/\\/g, '/').toLowerCase();
  const matches = [];
  for (const entry of readdirSync(root)) {
    const manifest = join(root, entry, 'workspace.json');
    if (!existsSync(manifest)) continue;
    try {
      const { folder } = JSON.parse(readFileSync(manifest, 'utf8'));
      if (!folder) continue;
      const path = decodeURIComponent(folder.replace(/^file:\/\/\//, '')).toLowerCase();
      if (path !== wanted && path !== `${wanted}/`) continue;
      const directory = join(root, entry);
      const database = join(directory, 'state.vscdb');
      matches.push({
        hash: entry,
        path: directory,
        folder,
        bytes: existsSync(database) ? statSync(database).size : 0,
        modified: existsSync(database) ? statSync(database).mtimeMs : 0,
      });
    } catch {
      continue;
    }
  }
  return matches.sort((a, b) => b.modified - a.modified || b.bytes - a.bytes);
}

function measure(path) {
  if (!existsSync(path)) return { present: false, files: 0, bytes: 0 };
  if (statSync(path).isFile()) return { present: true, files: 1, bytes: statSync(path).size };
  let files = 0;
  let bytes = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        files += 1;
        bytes += statSync(full).size;
      }
    }
  };
  walk(path);
  return { present: true, files, bytes };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

const candidates = storageForWorkspace();
if (candidates.length === 0) {
  console.error(`No VS Code workspace storage found for ${repo}.`);
  console.error('Open this folder in VS Code at least once, then run this again.');
  process.exit(1);
}
const storage = candidates[0];

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = join(repo, 'data', 'session-backups', stamp);
mkdirSync(destination, { recursive: true });

const items = [
  'workspace.json',
  'state.vscdb',
  'state.vscdb-wal',
  'state.vscdb-shm',
  'chatSessions',
  'GitHub.copilot-chat',
  ...(slim ? [] : ['chatEditingSessions']),
];

const copied = {};
for (const item of items) {
  const from = join(storage.path, item);
  const stats = measure(from);
  copied[item] = stats;
  if (!stats.present) continue;
  cpSync(from, join(destination, item), { recursive: true });
}

const warnings = [];
if (!copied.chatSessions?.present || copied.chatSessions.files === 0) {
  warnings.push(
    'chatSessions/ is empty. VS Code had not written a reopenable session at backup time. ' +
      'The conversation is still captured in GitHub.copilot-chat/transcripts, but restoring ' +
      'the chat into the VS Code UI may not work from this backup. Close VS Code and run ' +
      'this again to capture a flushed session.',
  );
}
if (slim)
  warnings.push('Run with --slim: chatEditingSessions/ (file edit snapshots) was not copied.');
if (candidates.length > 1) {
  warnings.push(
    `${candidates.length} storage folders claim this path; backed up the most recently written ` +
      `(${storage.hash}). Others: ${candidates
        .slice(1)
        .map((c) => `${c.hash} ${(c.bytes / 1024 / 1024).toFixed(2)}MB`)
        .join(', ')}.`,
  );
}
let git = null;
try {
  const at = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git = {
    branch: at(['branch', '--show-current']),
    head: at(['rev-parse', 'HEAD']),
    dirty: at(['status', '--porcelain']).length > 0,
  };
} catch {
  git = null;
}

const manifest = {
  takenAt: new Date().toISOString(),
  platform: platform(),
  repository: repo,
  workspaceFolderUri: storage.folder,
  workspaceStorageHash: storage.hash,
  candidatesConsidered: candidates.map((c) => ({
    hash: c.hash,
    bytes: c.bytes,
    modified: new Date(c.modified).toISOString(),
  })),
  git,
  contents: copied,
  warnings,
  restore: [
    'The storage folder is named for a hash of the workspace path, so the hash on the new',
    'machine will differ. Do not copy this backup to the old hash.',
    '1. Clone the repository on the new machine and open the folder in VS Code once.',
    '2. Close VS Code completely.',
    '3. Find the new storage folder: the one under workspaceStorage whose workspace.json',
    '   "folder" matches the new path.',
    '4. Copy chatSessions/ and GitHub.copilot-chat/ from this backup into it.',
    '5. Reopen VS Code.',
    'state.vscdb is included for reference. Overwriting it replaces all workspace UI state,',
    'not just the chat, so prefer the two folders above unless you accept that.',
    'The engineering state that actually matters - .ai/, review.txt, .github/agents/ - is in',
    'git and needs none of this.',
  ],
};
writeFileSync(join(destination, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\nBacked up to  ${destination}\n`);
for (const [item, stats] of Object.entries(copied)) {
  const status = stats.present
    ? `${String(stats.files).padStart(5)} files  ${mb(stats.bytes).padStart(10)}`
    : '    absent';
  console.log(`  ${item.padEnd(24)} ${status}`);
}
const total = Object.values(copied).reduce((sum, item) => sum + item.bytes, 0);
console.log(`  ${'total'.padEnd(24)} ${' '.repeat(12)}${mb(total).padStart(10)}`);
for (const warning of warnings) console.log(`\n  WARNING: ${warning}`);
console.log('\n  This backup contains the conversation. It is gitignored - keep it that way.\n');
