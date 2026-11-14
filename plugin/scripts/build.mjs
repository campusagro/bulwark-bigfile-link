import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  outfile: 'dist/index.js',
  external: [
    'react',
    'react-dom',
    'react-dom/client',
    'react/jsx-runtime',
    '@plugin-host',
  ],
});
await copyFile('manifest.json', 'dist/manifest.json');

