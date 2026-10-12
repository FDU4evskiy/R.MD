import { mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'docs', 'screenshots');
const examples = (await readdir(join(root, 'examples')))
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => join(root, 'examples', name));

if (!examples.length) throw new Error('No Markdown examples found.');
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'ru-RU',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pathToFileURL(join(root, 'index.html')).href);
  await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
  await page.locator('#fileInput').setInputFiles(examples);
  await page.waitForFunction(
    (count) => document.querySelector('#fileCount').textContent === String(count),
    examples.length,
  );
  await page.waitForSelector('#storageStatus[data-save-state="saved"]');
  await page.locator('#toastClose').click();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(output, 'reader-light.png') });

  await page.setViewportSize({ width: 1600, height: 1300 });
  await page.locator('#allView').click();
  await page.locator('#columns').selectOption('3');
  await page.waitForSelector('#storageStatus[data-save-state="saved"]');
  await page.screenshot({ path: join(output, 'collection.png') });

  await page.setViewportSize({ width: 1440, height: 1280 });
  await page.locator('.file-open').filter({ hasText: '04-api.md' }).click();
  await page.locator('#themeToggle').click();
  await page.waitForSelector('#storageStatus[data-save-state="saved"]');
  await page.screenshot({ path: join(output, 'reader-dark.png') });

  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  await context.close();
  console.log('Saved 3 screenshots to docs/screenshots/.');
} finally {
  await browser.close();
}
