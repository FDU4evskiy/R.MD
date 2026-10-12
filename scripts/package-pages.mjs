import { copyFile, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '_site');
const allowedFiles = new Set(['index.html', '.nojekyll']);

try {
  const info = await lstat(output);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('_site must be a regular directory.');
  }
  const unexpected = (await readdir(output)).filter((name) => !allowedFiles.has(name));
  if (unexpected.length) {
    throw new Error(
      `Remove unexpected files from _site before packaging: ${unexpected.join(', ')}`,
    );
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

await mkdir(output, { recursive: true });
await copyFile(path.join(root, 'index.html'), path.join(output, 'index.html'));
await writeFile(path.join(output, '.nojekyll'), '', 'utf8');
console.log('GitHub Pages artifact ready: _site/index.html');
