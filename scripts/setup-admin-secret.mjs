import { randomBytes } from 'node:crypto';
import { appendFile, chmod, lstat, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

export async function setupAdminSecret(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Expected a regular local environment file.');
  const contents = await readFile(path, 'utf8');
  if (parseEnv(contents).ADMIN_SNAPSHOT_PASSPHRASE)
    throw new Error('A snapshot passphrase is already configured; it was not changed.');
  await chmod(path, 0o600);
  await appendFile(path, `\nADMIN_SNAPSHOT_PASSPHRASE=${randomBytes(32).toString('base64url')}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await setupAdminSecret(fileURLToPath(new URL('../.env', import.meta.url)));
  process.stdout.write(
    'Generated a strong snapshot passphrase in the local .env with owner-only permissions. No secret was printed.\n',
  );
}
