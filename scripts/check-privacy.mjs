import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

const root = process.cwd();
const textExtensions = new Set([
  '.cjs',
  '.css',
  '.csv',
  '.env',
  '.example',
  '.html',
  '.ini',
  '.json',
  '.js',
  '.jsx',
  '.md',
  '.mjs',
  '.ps1',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yml',
  '.yaml',
  '',
]);

const forbiddenNames =
  /(^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|dump|sqlite|sqlite3|db|session|log))(?:$|\/)/i;
const privatePaths = /(^|\/)(?:data|logs|uploads|backups?|screenshots?|\.codeatlas)(?:\/|$)/i;
const allowlistedEmailDomains = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example.invalid',
  'example.test',
  'employer.example',
  'localhost',
  'gserviceaccount.com',
]);
const fixturePath =
  /(?:\.test\.|\.test\b|__fixtures__|^seed\/|^mobile-site\/|^docs\/archive\/|^infra\/|^design\/|^review\.txt$)/i;

const detectors = [
  ['private-key', /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
  ['provider-api-key', /\b(?:sk-or-v1-|sk-[A-Za-z0-9]{20,}|xai-[A-Za-z0-9_-]{20,})\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  [
    'database-credential-url',
    /\b(?:postgres(?:ql)?|mysql|redis):\/\/[^\s:@]+:(?!\$\{)[^\s@]+@(?!localhost\b|127\.0\.0\.1\b|example\.com\b|\$\{)/i,
  ],
];

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root })
    .toString()
    .split('\0')
    .filter(Boolean);
}

function isTextPath(path) {
  return textExtensions.has(extname(path).toLowerCase()) || basename(path).startsWith('.env');
}

export function scanContent(content, path = '<memory>') {
  const findings = [];
  for (const [type, pattern] of detectors)
    if (pattern.test(content)) findings.push({ type, path, severity: 'P1' });
  const emailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
  for (const match of content.matchAll(emailPattern)) {
    const domain = match[1].toLowerCase();
    if (
      !allowlistedEmailDomains.has(domain) &&
      !domain.endsWith('.invalid') &&
      !domain.endsWith('.gserviceaccount.com') &&
      !fixturePath.test(path)
    ) {
      findings.push({ type: 'possible-personal-email', path, severity: 'P2' });
      break;
    }
  }
  if (!fixturePath.test(path) && /(?:^|\D)\+?91[- .]?[6-9]\d{9}(?:\D|$)/.test(content)) {
    findings.push({ type: 'possible-personal-phone', path, severity: 'P2' });
  }
  return findings;
}

export function scanTracked(paths = trackedFiles()) {
  const findings = [];
  for (const path of paths) {
    if (forbiddenNames.test(path)) {
      if (path !== '.env.example')
        findings.push({ type: 'forbidden-private-file', path, severity: 'P1' });
      continue;
    }
    if (privatePaths.test(path) && !path.startsWith('seed/'))
      findings.push({ type: 'private-artifact-path', path, severity: 'P2' });
    if (!isTextPath(path)) continue;
    let content;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      findings.push({ type: 'unreadable-tracked-file', path, severity: 'P1' });
      continue;
    }
    findings.push(...scanContent(content, path));
  }
  return findings;
}

export function scanHistory() {
  let names = '';
  try {
    names = execFileSync('git', ['log', '--all', '--name-only', '--format='], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch {
    return [{ type: 'history-scan-timeout', path: 'git history', severity: 'P2' }];
  }
  const findings = [];
  const unique = [...new Set(names.split(/\r?\n/).filter(Boolean))];
  if (
    unique.some((path) =>
      /(?:\.env(?:\.|$)|\.(?:pem|key|p12|pfx|dump|sqlite|db|session|log)$|(?:^|\/)(?:data|logs|uploads|backups?)(?:\/|$))/i.test(
        path,
      ),
    )
  ) {
    findings.push({
      type: 'historical-private-path',
      path: `${unique.filter((path) => /(?:\.env(?:\.|$)|\.(?:pem|key|p12|pfx|dump|sqlite|db|session|log)$|(?:^|\/)(?:data|logs|uploads|backups?)(?:\/|$))/i.test(path)).length} historical path(s)`,
      severity: 'P2',
    });
  }
  return findings;
}

const invokedPath = process.argv[1]?.replaceAll('\\', '/');
if (invokedPath?.endsWith('/check-privacy.mjs') || invokedPath === 'check-privacy.mjs') {
  const findings = scanTracked();
  const history = process.argv.includes('--history') ? scanHistory() : [];
  const all = [...findings, ...history];
  if (all.length) {
    for (const finding of all)
      console.error(`privacy:${finding.severity} ${finding.type} at ${finding.path}`);
    process.exitCode = all.some((finding) => finding.severity === 'P1') ? 1 : 0;
  } else {
    process.stdout.write(
      'Privacy scan passed: no high-confidence secrets or private artifacts in tracked files.',
    );
  }
  if (process.argv.includes('--history') && !history.length)
    process.stdout.write('History scan passed: no matching secret/private-path evidence.\n');
}
