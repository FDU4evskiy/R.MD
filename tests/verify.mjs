import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launchOptions = {
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
};
const artifactDirectory = path.join(root, 'tests', 'artifacts');
await mkdir(artifactDirectory, { recursive: true });
const userDataDirectory = await mkdtemp(path.join(artifactDirectory, '.browser-profile-'));
const viewerUrl = pathToFileURL(path.join(root, 'index.html')).href;
const unsafeMarkdown = [
  '<script>window.__unsafeMarkdown = true</script>',
  '<img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" onload="window.__unsafeMarkdown = true" onerror="window.__unsafeMarkdown = true">',
  '<a href="javascript:window.__unsafeMarkdown=true">Unsafe link</a>',
  '<iframe srcdoc="<script>parent.__unsafeMarkdown=true</script>"></iframe>',
  '<div class="drop-overlay">Layout attack sample</div>',
].join('\n');

function createFixture(number) {
  const name = number > 18 ? 'duplicate.md' : `document-${String(number).padStart(2, '0')}.md`;
  const lines = [`# Document ${number}`, '', `Unique content marker ${number}.`, ''];
  if (number === 1) {
    lines.push('Это пример документа на русском языке. Файлы читаются прямо в браузере.', '');
  }
  lines.push(
    '## Second heading',
    '',
    '| Column A | Column B |',
    '| --- | --- |',
    '| value | value |',
    '',
    '```js',
    `const documentNumber = ${number};`,
    '```',
    '',
    '- [x] Completed',
    '- [ ] Pending',
    '',
  );
  if (number === 2) lines.push('# intro', '', '# intro', '', '# intro-1', '');
  if (number === 20) lines.push(unsafeMarkdown);
  if (number === 1) {
    for (let section = 1; section <= 30; section++) {
      lines.push(
        '',
        `## Reading section ${section}`,
        '',
        `Section ${section}: review the release notes, confirm the checklist, and record any outstanding work.`,
      );
    }
  }
  return { name, mimeType: 'text/markdown', buffer: Buffer.from(lines.join('\n'), 'utf8') };
}

const fixtures = Array.from({ length: 20 }, (_, index) => createFixture(index + 1));

let context;
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const externalRequests = [];
let page;
async function openContext() {
  context = await chromium.launchPersistentContext(userDataDirectory, {
    ...launchOptions,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  page = context.pages()[0] || (await context.newPage());
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) =>
    failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`),
  );
  page.on('request', (request) => {
    if (/^https?:/i.test(request.url())) externalRequests.push(request.url());
  });
}

async function checkNoPageOverflow(label) {
  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(
    dimensions.scroll <= dimensions.client + 1,
    `${label}: page width ${dimensions.scroll} exceeds viewport ${dimensions.client}`,
  );
}

async function waitForCount(selector, expected) {
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelectorAll(selector).length === expected,
    { selector, expected },
  );
}

async function waitForReady(target = page) {
  await target.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
}

async function waitForSaved(target = page) {
  try {
    await target.waitForFunction(() =>
      ['saved', 'error'].includes(document.querySelector('#storageStatus').dataset.saveState),
    );
    assert.equal(await target.locator('#storageStatus').getAttribute('data-save-state'), 'saved');
  } catch (error) {
    const details = await target.locator('#storageStatus').evaluate((element) => ({
      state: element.dataset.saveState,
      title: element.title,
      text: element.innerText,
    }));
    throw new Error(
      `Workspace did not finish saving: ${JSON.stringify({ ...details, pageErrors, consoleErrors })}`,
      { cause: error },
    );
  }
}

async function reloadWorkspace(expectedCount) {
  await waitForSaved();
  await page.reload();
  await waitForReady();
  await waitForCount('#fileList .file-item', expectedCount);
}

async function scrollTo(selector, position, target = page) {
  await target
    .locator(selector)
    .first()
    .evaluate((element, top) => {
      element.style.scrollBehavior = 'auto';
      element.scrollTop = top;
    }, position);
  await target.waitForFunction(
    ({ selector, position }) =>
      Math.abs(document.querySelector(selector).scrollTop - position) <= 1,
    { selector, position },
  );
  // Capture the position before waiting for the debounced save.
  await target
    .locator(selector)
    .first()
    .evaluate((element) => element.dispatchEvent(new Event('scroll')));
}

async function checkScrollRestored(selector, position, label) {
  try {
    await page.waitForFunction(
      ({ selector, position }) =>
        Math.abs(document.querySelector(selector).scrollTop - position) <= 1,
      { selector, position },
      { timeout: 3000 },
    );
  } catch (error) {
    const actual = await page
      .locator(selector)
      .first()
      .evaluate((element) => element.scrollTop);
    throw new Error(`${label}: expected ${position}, restored ${actual}`, { cause: error });
  }
}

async function checkSavedDocuments() {
  const stored = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('rmd-workspace', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const key = location.pathname.replace(/index\.html$/, '').replace(/\/$/, '') || '/';
      return await new Promise((resolve, reject) => {
        const request = database.transaction('documents').objectStore('documents').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
  assert.deepEqual(
    stored.map(({ name, content }) => ({ name, content })),
    fixtures.map(({ name, buffer }) => ({ name, content: buffer.toString('utf8') })),
    'all filenames and original Markdown contents are persisted',
  );
}

async function checkStorageFailure(kind) {
  const browser = await chromium.launch(launchOptions);
  const isolated = await browser.newContext();
  const target = await isolated.newPage();
  const errors = [];
  target.on('pageerror', (error) => errors.push(error.message));
  await target.addInitScript((kind) => {
    if (kind === 'unavailable') {
      Object.defineProperty(window, 'indexedDB', {
        configurable: true,
        get() {
          throw new DOMException('Storage is disabled', 'SecurityError');
        },
      });
    } else {
      IDBObjectStore.prototype.put = function () {
        throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      };
    }
  }, kind);
  try {
    await target.goto(viewerUrl);
    await waitForReady(target);
    await target.locator('#fileInput').setInputFiles(fixtures.slice(0, 1));
    await target.waitForFunction(
      () => document.querySelectorAll('#fileList .file-item').length === 1,
    );
    await target.waitForFunction(
      () => document.querySelector('#storageStatus').dataset.saveState === 'error',
    );
    assert.equal(
      await target.locator('#storageStatus').isVisible(),
      true,
      `${kind}: save failure is visible`,
    );
    assert.ok(
      (await target.locator('#storageStatus').innerText()).trim(),
      `${kind}: save failure has a readable message`,
    );
    assert.equal(
      await target.locator('#reader h1').innerText(),
      'Document 1',
      `${kind}: document remains readable`,
    );
    await target.setViewportSize({ width: 375, height: 812 });
    assert.equal(
      await target.locator('#documentStatus').isVisible(),
      true,
      `${kind}: mobile save failure status is visible`,
    );
    assert.match(
      await target.locator('#documentStatus').innerText(),
      /Не сохранено/,
      `${kind}: mobile footer includes save failure`,
    );
    assert.deepEqual(errors, [], `${kind}: persistence failure does not crash the application`);
  } finally {
    await browser.close();
  }
}

async function checkMalformedStorage() {
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('rmd-workspace', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const key = location.pathname.replace(/index\.html$/, '').replace(/\/$/, '') || '/';
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(['documents', 'sessions'], 'readwrite');
        transaction.objectStore('documents').put(
          [
            null,
            { id: 'bad', name: 123, content: {} },
            {
              id: 'doc-80',
              name: 'valid.md',
              path: 'valid.md',
              size: 12,
              content: '# Valid restored document',
              html: '<script>window.__storedHtmlExecuted = true</script>',
            },
          ],
          key,
        );
        transaction.objectStore('sessions').put(
          {
            version: 1,
            activeId: 'missing',
            view: 'invalid',
            source: {},
            fontSize: 999,
            columns: -1,
            scroll: null,
          },
          key,
        );
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  });
  await page.reload();
  await waitForReady();
  await waitForCount('#fileList .file-item', 1);
  assert.equal(
    await page.locator('#reader h1').innerText(),
    'Valid restored document',
    'valid document survives malformed records and session metadata',
  );
  assert.equal(
    await page.evaluate(() => window.__storedHtmlExecuted),
    undefined,
    'stored rendered HTML is not trusted',
  );
  await page.locator('#fileInput').setInputFiles(fixtures.slice(0, 1));
  await waitForCount('#fileList .file-item', 2);
  const ids = await page
    .locator('#fileList .file-item')
    .evaluateAll((items) => items.map((item) => item.dataset.id));
  assert.equal(
    new Set(ids).size,
    2,
    'new imports have distinct IDs after restoring high document IDs',
  );
}

async function checkToolbarBounds(label) {
  const outOfBounds = await page
    .locator('.app-header button, .workspace-toolbar button, .workspace-toolbar select')
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return [];
        return rect.left < -1 || rect.right > innerWidth + 1
          ? [
              {
                id: element.id || element.className,
                left: rect.left,
                right: rect.right,
                width: innerWidth,
              },
            ]
          : [];
      }),
    );
  assert.deepEqual(outOfBounds, [], `${label}: toolbar controls outside viewport`);
}

async function checkImports() {
  await page.goto(viewerUrl);
  await waitForReady();
  assert.equal(await page.locator('#emptyState').isVisible(), true, 'empty state visible');
  await page.screenshot({ path: path.join(artifactDirectory, 'empty.png'), fullPage: true });
  assert.equal(
    await page.locator('#fileInput').getAttribute('multiple'),
    '',
    'multiple upload enabled',
  );
  await page.locator('#fileInput').setInputFiles(fixtures);
  await waitForCount('#fileList .file-item', 20);
  assert.equal((await page.locator('#fileCount').innerText()).trim(), '20', '20 files loaded');

  await page.locator('#singleView').click();
  assert.equal(
    await page.locator('#reader h1').innerText(),
    'Document 1',
    'first document rendered',
  );
  assert.equal(await page.locator('#reader table').count(), 1, 'Markdown table rendered');
  assert.equal(
    await page.locator('#reader input[type="checkbox"]').count(),
    2,
    'task list rendered',
  );
  assert.equal(
    await page.locator('#reader pre code').innerText(),
    'const documentNumber = 1;\n',
    'code fence rendered',
  );
  await page.screenshot({ path: path.join(artifactDirectory, 'single.png'), fullPage: true });
}

async function checkGridRendering() {
  await page.locator('#allView').click();
  await waitForCount('#documentGrid .document-card', 20);
  assert.equal(await page.locator('#allPane').isVisible(), true, 'all-files view visible');
  const headings = await page
    .locator('#documentGrid .document-card')
    .evaluateAll((cards) => cards.map((card) => card.querySelector('h1').textContent));
  assert.deepEqual(
    headings,
    Array.from({ length: 20 }, (_, index) => `Document ${index + 1}`),
    'all 20 documents have independent rendered content',
  );
  assert.equal(
    await page
      .locator('#documentGrid .card-title')
      .filter({ hasText: /^duplicate\.md \([12]\)$/ })
      .count(),
    2,
    'duplicate filenames retained',
  );
  const collisionIds = await page
    .locator('#documentGrid .document-card')
    .nth(1)
    .locator('h1')
    .evaluateAll((elements) => elements.map((element) => element.id));
  assert.equal(collisionIds.length, 4, 'heading collision fixture rendered');
  assert.equal(
    new Set(collisionIds).size,
    collisionIds.length,
    'repeated and suffixed headings get unique IDs',
  );

  assert.equal(
    await page.evaluate(() => window.__unsafeMarkdown),
    undefined,
    'unsafe scripts did not execute',
  );
  assert.equal(
    await page
      .locator(
        '.markdown-body script, .markdown-body iframe, .markdown-body [onerror], .markdown-body [onload], .markdown-body a[href^="javascript:"]',
      )
      .count(),
    0,
    'dangerous HTML and attributes removed',
  );
  assert.equal(
    await page.locator('.markdown-body .drop-overlay').count(),
    0,
    'imported classes cannot trigger application overlays',
  );
  assert.equal(
    await page
      .locator('#documentGrid .document-card')
      .nth(19)
      .locator('div')
      .filter({ hasText: /^Layout attack sample$/ })
      .count(),
    1,
    'safe text from imported raw HTML retained',
  );
  await page
    .locator('#documentGrid .card-content')
    .first()
    .evaluate((element) => {
      element.scrollTop = 120;
    });
  const cardScrollBefore = await page
    .locator('#documentGrid .card-content')
    .first()
    .evaluate((element) => element.scrollTop);
  assert.ok(cardScrollBefore > 0, 'test card has scrollable content');
  await page.locator('#columns').selectOption('3');
  assert.equal(
    await page
      .locator('#documentGrid .card-content')
      .first()
      .evaluate((element) => element.scrollTop),
    cardScrollBefore,
    'card scroll survives changing to three columns',
  );
  await page.locator('#columns').selectOption('2');
  assert.equal(
    await page
      .locator('#documentGrid .card-content')
      .first()
      .evaluate((element) => element.scrollTop),
    cardScrollBefore,
    'card scroll survives changing back to two columns',
  );
  await page
    .locator('#documentGrid .card-content')
    .first()
    .evaluate((element) => {
      element.scrollTop = 0;
    });
}

async function checkSearch() {
  await page.locator('#fileSearch').fill('marker 17.');
  await waitForCount('#documentGrid .document-card', 1);
  assert.equal(
    await page.locator('#documentGrid h1').innerText(),
    'Document 17',
    'search finds file content',
  );
  assert.equal(
    await page.locator('#fileList .file-item').count(),
    1,
    'sidebar matches filtered grid',
  );
  await page.locator('#fileSearch').fill('no-such-document-xyz');
  await waitForCount('#documentGrid .document-card', 0);
  assert.equal(await page.locator('#noResults').isVisible(), true, 'no-result state visible');
  await page.locator('#fileSearch').fill('');
  await waitForCount('#documentGrid .document-card', 20);
}

async function checkReaderControls() {
  await page.locator('#documentGrid .card-title').nth(19).click();
  assert.equal(
    await page.locator('#reader h1').innerText(),
    'Document 20',
    'duplicate filename opens correct document',
  );
  await page.locator('#sourceToggle').click();
  assert.equal(await page.locator('#source').isVisible(), true, 'raw Markdown view visible');
  assert.match(
    await page.locator('#source').innerText(),
    /^# Document 20\n/,
    'raw Markdown preserved',
  );
  assert.equal(
    await page.evaluate(() => window.__unsafeMarkdown),
    undefined,
    'source mode cannot execute unsafe HTML',
  );
  await page.locator('#sourceToggle').click();
  const fontBefore = await page
    .locator('#reader')
    .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  await page.locator('#fontIncrease').click();
  assert.ok(
    (await page
      .locator('#reader')
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize))) > fontBefore,
    'font-size control changes reader',
  );
  await page.locator('#fontDecrease').click();
}

async function checkWorkspacePersistence() {
  await page.locator('#fileList .file-open').first().click();
  await scrollTo('#readerScroll', 400);
  await reloadWorkspace(20);
  assert.equal(
    await page.locator('#reader h1').innerText(),
    'Document 1',
    'active document survives reload',
  );
  assert.equal(await page.locator('#singlePane').isVisible(), true, 'single view survives reload');
  await checkScrollRestored('#readerScroll', 400, 'single reading position survives reload');
  await page.locator('#sourceToggle').click();
  await scrollTo('#readerScroll', 550);
  await page.locator('#fontIncrease').click();
  await reloadWorkspace(20);
  assert.equal(
    await page.locator('#source').textContent(),
    fixtures[0].buffer.toString('utf8'),
    'raw Markdown and source mode survive reload',
  );
  assert.equal(await page.locator('#fontValue').innerText(), '17', 'font size survives reload');
  await checkScrollRestored('#readerScroll', 550, 'source reading position survives reload');
  await page.locator('#allView').click();
  await page.locator('#columns').selectOption('3');
  await scrollTo('#documentGrid .card-content', 240);
  await scrollTo('#allPane', 300);
  await waitForSaved();
  await checkSavedDocuments();
  await reloadWorkspace(20);
  assert.equal(await page.locator('#allPane').isVisible(), true, 'all-files view survives reload');
  assert.equal(
    await page.locator('#columns').inputValue(),
    '3',
    'column preference survives reload',
  );
  assert.equal(
    await page.locator('#sourceToggle').getAttribute('aria-pressed'),
    'true',
    'grid source mode survives reload',
  );
  await checkScrollRestored(
    '#documentGrid .card-content',
    240,
    'grid document position survives reload',
  );
  await checkScrollRestored('#allPane', 300, 'collection position survives reload');
  const restoredSources = await page.locator('#documentGrid .source-body').allTextContents();
  assert.deepEqual(
    restoredSources,
    fixtures.map(({ buffer }) => buffer.toString('utf8')),
    'all 20 document contents survive reload',
  );

  await context.close();
  await openContext();
  await page.goto(viewerUrl);
  await waitForReady();
  await waitForCount('#fileList .file-item', 20);
  assert.equal(
    await page.locator('#allPane').isVisible(),
    true,
    'workspace survives closing and reopening the browser profile',
  );
  assert.equal(
    await page.locator('#sourceToggle').getAttribute('aria-pressed'),
    'true',
    'source mode survives reopening the browser profile',
  );
  await checkSavedDocuments();
  await page.locator('#sourceToggle').click();
  await page.locator('#fontDecrease').click();
}

async function checkRemovalAndUndo() {
  await page.locator('#fileList .file-open').nth(14).click();
  assert.equal(
    await page.locator('#reader h1').innerText(),
    'Document 15',
    'sidebar opens selected document',
  );
  await page.locator('#fileList .file-close').nth(14).click();
  await waitForCount('#fileList .file-item', 19);
  assert.equal(
    await page.locator('#reader h1').innerText(),
    'Document 16',
    'closing active file selects next document',
  );
  await reloadWorkspace(19);
  assert.equal(
    await page.locator('#reader h1').innerText(),
    'Document 16',
    'removed document stays removed after reload',
  );
  await page.locator('#fileInput').setInputFiles(fixtures.slice(14, 15));
  await waitForCount('#fileList .file-item', 20);
  await page.locator('#fileList .file-open').last().click();
  await page.locator('#fileList .file-close').last().click();
  await waitForCount('#fileList .file-item', 19);
  await page.locator('#toastUndo').click();
  await waitForCount('#fileList .file-item', 20);
  assert.equal(
    await page.locator('#reader h1').innerText(),
    'Document 15',
    'undo restores closed document',
  );
  await reloadWorkspace(20);
  assert.equal(
    await page.locator('#reader h1').innerText(),
    'Document 15',
    'undo result survives reload',
  );
  await page.locator('#clearAll').click();
  await waitForCount('#fileList .file-item', 0);
  assert.equal(
    await page.locator('#emptyState').isVisible(),
    true,
    'closing all files returns empty state',
  );
  await page.locator('#toastUndo').click();
  await waitForCount('#fileList .file-item', 20);
  assert.equal(
    await page.locator('#reader h1').innerText(),
    'Document 15',
    'undo restores all files and active document',
  );
  await reloadWorkspace(20);
}

async function checkResponsiveViews() {
  await page.locator('#allView').click();
  await page.locator('#columns').selectOption('3');
  await page.locator('#allPane').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: path.join(artifactDirectory, 'desktop.png'), fullPage: true });
  await checkNoPageOverflow('desktop');
  await checkToolbarBounds('desktop');

  const themeBefore = await page
    .locator('body')
    .evaluate((element) => element.classList.contains('dark'));
  await page.locator('#themeToggle').click();
  assert.equal(
    await page.locator('body').evaluate((element) => element.classList.contains('dark')),
    !themeBefore,
    'theme toggles',
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForFunction(
    () => document.querySelector('#sidebar').getBoundingClientRect().right <= 1,
  );
  await checkNoPageOverflow('mobile 375');
  await checkToolbarBounds('mobile 375');
  assert.equal(
    await page
      .locator('#documentGrid')
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    1,
    'mobile grid uses one column',
  );
  await page.screenshot({ path: path.join(artifactDirectory, 'mobile.png'), fullPage: true });
  await page.locator('#sidebarToggle').click();
  assert.equal(
    await page.locator('body').evaluate((element) => element.classList.contains('sidebar-open')),
    true,
    'mobile sidebar opens',
  );
  await page.locator('#fileList .file-open').last().click();
  assert.equal(
    await page.locator('#reader h1').innerText(),
    'Document 15',
    'mobile file selection works',
  );
  assert.equal(
    await page.locator('body').evaluate((element) => element.classList.contains('sidebar-open')),
    false,
    'mobile file selection closes sidebar',
  );
  await page.setViewportSize({ width: 320, height: 700 });
  await checkNoPageOverflow('mobile 320');
  await checkToolbarBounds('mobile 320');

  await reloadWorkspace(20);
  assert.equal(
    await page.locator('body').evaluate((element) => element.classList.contains('dark')),
    !themeBefore,
    'theme preference survives reload',
  );
}

async function checkClearPersistence() {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#clearAll').click();
  await waitForCount('#fileList .file-item', 0);
  await reloadWorkspace(0);
  assert.equal(
    await page.locator('#emptyState').isVisible(),
    true,
    'cleared workspace stays empty after reload',
  );
}

try {
  await openContext();
  await checkImports();
  await checkGridRendering();
  await checkSearch();
  await checkReaderControls();
  await checkWorkspacePersistence();
  await checkRemovalAndUndo();
  await checkResponsiveViews();
  await checkClearPersistence();
  await checkMalformedStorage();
  await checkStorageFailure('unavailable');
  await checkStorageFailure('quota');
  assert.deepEqual(pageErrors, [], 'browser JavaScript errors');
  assert.deepEqual(externalRequests, [], 'standalone viewer works without external HTTP requests');
  assert.deepEqual(failedRequests, [], 'all local resources load');
  assert.deepEqual(consoleErrors, [], 'browser console errors');
  console.log(
    `Browser checks passed: ${fixtures.length} documents, Markdown rendering, persistence, storage failures, and responsive layout.`,
  );
  console.log(`Screenshots: ${path.relative(root, artifactDirectory)}`);
} finally {
  await context?.close();
  await rm(userDataDirectory, { recursive: true, force: true });
}
