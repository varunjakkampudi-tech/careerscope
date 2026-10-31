import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// SIGTERM from an orchestrator must stop the API cleanly with exit code 0. Windows cannot deliver
// SIGTERM to a child process gracefully, so this runs on POSIX only (CI runs on Linux).
test(
  'the API exits 0 on SIGTERM after it has started',
  { timeout: 120_000, skip: process.platform === 'win32' && 'SIGTERM is not graceful on Windows' },
  async () => {
    const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
    const child = spawn(process.execPath, ['--env-file=.env', '--import', 'tsx', entry], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', (code) => resolve(code)),
    );
    const started = new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        log += chunk.toString('utf8');
        if (log.includes('Server listening')) resolve();
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
      child.once('exit', (code) =>
        reject(new Error(`API exited before listening (${code}): ${log}`)),
      );
    });
    try {
      await started;
      child.kill('SIGTERM');
      assert.equal(await exited, 0, log);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  },
);
