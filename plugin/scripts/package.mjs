import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';

await rm('bigfile-link.zip', { force: true });
execFileSync('zip', ['-q', '-j', 'bigfile-link.zip', 'dist/index.js', 'dist/manifest.json'], {
  stdio: 'inherit',
});

