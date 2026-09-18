import { spawn } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const sessionTabs = [
  'https://github.com/varunjakkampudi-tech/careerscope/actions/runs/34487640159',
  'https://mail.google.com/mail/u/0/#search/' +
    encodeURIComponent(
      'is:unread {from:linkedin.com from:naukri.com from:indeed.com subject:job subject:opportunity subject:interview subject:application}',
    ),
  'https://www.naukri.com/mnjuser/homepage',
  'https://in.indeed.com/?from=gnav-viewjob',
  'https://www.linkedin.com/jobs/view/4465704104/',
];

export function browserCommand(platform, url) {
  if (!sessionTabs.includes(url)) throw new Error('Unknown session URL');
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'linux') return ['xdg-open', [url]];
  if (platform === 'win32')
    return [
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process -FilePath '${url.replaceAll("'", "''")}'`,
      ],
    ];
  throw new Error('Unsupported desktop platform; use the links in docs/SESSION-HANDOFF.md');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--print'))
    throw new Error('Usage: node scripts/open-session-tabs.mjs [--print]');
  if (args[0] === '--print') {
    process.stdout.write(`${JSON.stringify(sessionTabs, null, 2)}\n`);
    return;
  }
  for (const url of sessionTabs) {
    const [command, args] = browserCommand(process.platform, url);
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { shell: false, stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error('Browser launch failed; open the handoff links manually')),
      );
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
