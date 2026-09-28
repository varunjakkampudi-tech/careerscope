import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const nextEntry = join(root, '..', '..', 'node_modules', 'next', 'dist', 'bin', 'next');

function runBuild(env) {
  const result = spawnSync(process.execPath, [nextEntry, 'build'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function htmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await htmlFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(path);
  }
  return files;
}

async function discoverHashes() {
  const hashes = new Set();
  for (const file of await htmlFiles(join(root, '.next', 'server', 'app'))) {
    const html = await readFile(file, 'utf8');
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      if (!match[1]) continue;
      hashes.add(`'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
    }
  }
  if (hashes.size === 0) throw new Error('CSP discovery found no inline scripts');
  return [...hashes].sort().join(' ');
}

runBuild({ CSP_HASH_DISCOVERY: '1' });
let hashes = await discoverHashes();
console.log(`CSP discovery: ${hashes.split(' ').length} inline script hash(es)`);
for (let pass = 2; pass <= 4; pass += 1) {
  runBuild({ CSP_SCRIPT_HASHES: hashes });
  const generated = new Set((await discoverHashes()).split(' '));
  const policy = new Set(hashes.split(' '));
  const missing = [...generated].filter((hash) => !policy.has(hash));
  if (missing.length === 0) {
    console.log(`CSP verification: pass ${pass} covers all ${generated.size} generated inline script hash(es)`);
    process.exit(0);
  }
  for (const hash of missing) policy.add(hash);
  hashes = [...policy].sort().join(' ');
  console.log(`CSP pass ${pass}: added ${missing.length} hash(es); rebuilding with the union`);
}
throw new Error('CSP script hashes did not converge after four deterministic build passes');
