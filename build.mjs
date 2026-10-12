import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const vendors = [
  { name: 'marked 18.1.1', file: 'marked.umd.js', license: 'marked.LICENSE.txt' },
  { name: 'DOMPurify 3.4.17', file: 'purify.min.js', license: 'dompurify.LICENSE.txt' },
  { name: 'lucide 1.55.0', file: 'lucide.min.js', license: 'lucide.LICENSE.txt' },
];

const read = (path) => readFile(join(root, path), 'utf8');
const escapeScript = (source) => source.replace(/<\/script/gi, '<\\/script');
const inlineScript = (source) => `<script>\n${escapeScript(source)}\n</script>`;

const [template, styles, app, libraries] = await Promise.all([
  read('src/index.html'),
  read('src/styles.css'),
  read('src/app.js'),
  Promise.all(
    vendors.map(async (vendor) => {
      const [source, license] = await Promise.all([
        read(`vendor/${vendor.file}`),
        read(`vendor/${vendor.license}`),
      ]);
      const notice = `/*! ${vendor.name}\n${license.replace(/\*\//g, '* /')}\n*/\n`;
      return inlineScript(notice + source);
    }),
  ),
]);

if (/<\/style/i.test(styles)) {
  throw new Error('CSS contains a closing style tag and cannot be safely inlined.');
}

const replacements = [
  ['<!-- STYLES -->', `<style>\n${styles}\n</style>`],
  ['<!-- VENDORS -->', libraries.join('\n')],
  ['<!-- APP -->', inlineScript(app)],
];

let output = template;
for (const [placeholder, replacement] of replacements) {
  if (output.split(placeholder).length !== 2) {
    throw new Error(`Expected exactly one ${placeholder} placeholder.`);
  }
  output = output.replace(placeholder, () => replacement);
}

await writeFile(join(root, 'index.html'), output, 'utf8');
console.log(`Built index.html (${Buffer.byteLength(output).toLocaleString('en-US')} bytes).`);
