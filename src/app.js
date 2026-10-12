(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries(
    [
      'fileInput',
      'fileSearch',
      'fileList',
      'fileCount',
      'emptyList',
      'searchSummary',
      'clearAll',
      'sortToggle',
      'sidebarStatus',
      'singleView',
      'allView',
      'columnControl',
      'columns',
      'fontDecrease',
      'fontIncrease',
      'fontValue',
      'sourceToggle',
      'outlineToggle',
      'themeToggle',
      'emptyState',
      'singlePane',
      'allPane',
      'activeName',
      'reader',
      'source',
      'readingLayout',
      'readerScroll',
      'outline',
      'outlineLinks',
      'documentGrid',
      'collectionCount',
      'noResults',
      'documentStatus',
      'readingProgress',
      'sidebarToggle',
      'sidebarBackdrop',
      'downloadFile',
      'dropOverlay',
      'toast',
      'toastText',
      'toastUndo',
      'toastClose',
      'storageStatus',
    ].map((id) => [id, $(id)]),
  );

  const state = {
    docs: [],
    activeId: null,
    view: 'single',
    query: '',
    sorted: false,
    source: false,
    outline: true,
    fontSize: 16,
    columns: 2,
  };
  let sequence = 0;
  let toastTimer;
  let undoAction = null;
  let dragDepth = 0;
  let importing = false;
  let workspaceReady = false;
  let storageDatabase;
  let storageOpen;
  let storageQueue = Promise.resolve();
  let saveTimer;
  let storageRevision = 0;
  let documentsDirty = false;
  let storageWarningShown = false;
  let collectionScroll = 0;
  const workspaceKey = location.pathname.replace(/index\.html$/, '').replace(/\/$/, '') || '/';
  const number = new Intl.NumberFormat('ru-RU');

  function storageStatus(status) {
    const labels = {
      loading: ['Восстановление…', 'Восстанавливаем документы из памяти браузера'],
      saving: ['Сохраняем…', 'Сохраняем документы и позицию чтения в этом браузере'],
      saved: [
        'Сохранено',
        'Документы сохранены в этом браузере и восстановятся после перезагрузки. Файлы не отправляются на сервер.',
      ],
      error: [
        'Не сохранено',
        'Браузер не разрешил сохранение. Документы доступны до закрытия страницы; скачайте нужные файлы.',
      ],
    };
    const [label, title] = labels[status];
    ui.storageStatus.dataset.saveState = status;
    ui.storageStatus.querySelector('span').textContent = label;
    ui.storageStatus.title = title;
    document.body.classList.toggle('storage-error', status === 'error');
    if (status === 'error' || status === 'saved') updateStatus();
  }

  function openStorage() {
    if (storageDatabase) return Promise.resolve(storageDatabase);
    if (storageOpen) return storageOpen;
    storageOpen = new Promise((resolve, reject) => {
      const request = indexedDB.open('rmd-workspace', 1);
      let settled = false;
      request.onupgradeneeded = () => {
        for (const store of ['documents', 'sessions']) {
          if (!request.result.objectStoreNames.contains(store))
            request.result.createObjectStore(store);
        }
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        storageDatabase = request.result;
        storageDatabase.onversionchange = () => {
          storageDatabase?.close();
          storageDatabase = null;
          storageOpen = null;
        };
        resolve(storageDatabase);
      };
      request.onerror = () => {
        settled = true;
        reject(request.error);
      };
      request.onblocked = () => {
        settled = true;
        reject(new Error('Storage is blocked by another tab'));
      };
    });
    storageOpen.catch(() => {
      storageOpen = null;
    });
    return storageOpen;
  }

  function storageError() {
    storageStatus('error');
    if (!storageWarningShown) {
      storageWarningShown = true;
      showToast('Не удалось сохранить документы в браузере. Они доступны до закрытия страницы.');
    }
  }

  function sessionSnapshot() {
    return {
      version: 1,
      activeId: state.activeId,
      view: state.view,
      source: state.source,
      outline: state.outline,
      sorted: state.sorted,
      query: state.query,
      columns: state.columns,
      fontSize: state.fontSize,
      collectionScroll,
      scroll: Object.fromEntries(state.docs.map((doc) => [doc.id, { ...doc.scroll }])),
    };
  }

  function persistWorkspace(withDocuments = false) {
    if (!workspaceReady) return Promise.resolve(false);
    clearTimeout(saveTimer);
    documentsDirty ||= withDocuments;
    const revision = ++storageRevision;
    const session = sessionSnapshot();
    // Content is written only when documents change, not on every scroll event.
    const documents = documentsDirty
      ? state.docs.map(({ id, name, path, size, content }) => ({ id, name, path, size, content }))
      : null;
    storageStatus('saving');
    const operation = storageQueue.then(async () => {
      const database = await openStorage();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(
          documents ? ['documents', 'sessions'] : ['sessions'],
          'readwrite',
        );
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Storage write failed'));
        transaction.onabort = () => reject(transaction.error || new Error('Storage write aborted'));
        try {
          transaction.objectStore('sessions').put(session, workspaceKey);
          if (documents) transaction.objectStore('documents').put(documents, workspaceKey);
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      });
      if (revision === storageRevision) {
        documentsDirty = false;
        storageWarningShown = false;
        storageStatus('saved');
      }
      return true;
    });
    storageQueue = operation.catch(() => {
      storageError();
      return false;
    });
    return storageQueue;
  }

  function scheduleSave() {
    if (!workspaceReady) return;
    clearTimeout(saveTimer);
    storageRevision++;
    storageStatus('saving');
    saveTimer = setTimeout(() => {
      persistWorkspace();
    }, 180);
  }

  function createDocument({ id, name, path, size, content }, scroll = {}) {
    return {
      id,
      name,
      path,
      size,
      content,
      words: content.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length || 0,
      search: `${name}\n${content}`.toLocaleLowerCase('ru'),
      html: null,
      scroll: Object.fromEntries(
        ['rendered', 'source', 'grid-rendered', 'grid-source'].map((key) => [
          key,
          Number.isFinite(scroll?.[key]) ? Math.max(0, scroll[key]) : 0,
        ]),
      ),
    };
  }

  async function restoreWorkspace() {
    document.querySelectorAll('.add-files').forEach((node) => {
      node.disabled = true;
    });
    try {
      const database = await openStorage();
      const saved = await new Promise((resolve, reject) => {
        const transaction = database.transaction(['documents', 'sessions'], 'readonly');
        const documents = transaction.objectStore('documents').get(workspaceKey);
        const session = transaction.objectStore('sessions').get(workspaceKey);
        transaction.oncomplete = () =>
          resolve({ documents: documents.result, session: session.result });
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      const session = saved.session?.version === 1 ? saved.session : {};
      const ids = new Set();
      if (Array.isArray(saved.documents)) {
        for (const doc of saved.documents) {
          if (
            !doc ||
            typeof doc.content !== 'string' ||
            typeof doc.name !== 'string' ||
            typeof doc.path !== 'string' ||
            !/^doc-\d+$/.test(doc.id) ||
            ids.has(doc.id)
          )
            continue;
          ids.add(doc.id);
          sequence = Math.max(sequence, Number(doc.id.slice(4)));
          state.docs.push(
            createDocument(
              {
                ...doc,
                size:
                  Number.isFinite(doc.size) && doc.size >= 0
                    ? doc.size
                    : new Blob([doc.content]).size,
              },
              session.scroll?.[doc.id],
            ),
          );
        }
      }
      state.activeId = ids.has(session.activeId) ? session.activeId : state.docs[0]?.id || null;
      state.view = session.view === 'all' ? 'all' : 'single';
      state.source = session.source === true;
      state.outline = session.outline !== false;
      state.sorted = session.sorted === true;
      state.query = typeof session.query === 'string' ? session.query : '';
      state.columns = [1, 2, 3].includes(session.columns) ? session.columns : state.columns;
      if (Number.isInteger(session.fontSize) && session.fontSize >= 12 && session.fontSize <= 24)
        setFont(session.fontSize);
      collectionScroll = Number.isFinite(session.collectionScroll)
        ? Math.max(0, session.collectionScroll)
        : 0;
      ui.fileSearch.value = state.query;
      ui.columns.value = String(state.columns);
      render();
      ui.allPane.scrollTop = collectionScroll;
      storageStatus('saved');
    } catch {
      storageError();
    } finally {
      workspaceReady = true;
      document.body.dataset.workspaceReady = 'true';
      document.querySelectorAll('.add-files').forEach((node) => {
        node.disabled = false;
      });
    }
  }

  function icon(name) {
    const element = document.createElement('i');
    element.dataset.lucide = name;
    return element;
  }

  function icons(root = document) {
    lucide.createIcons({ root, attrs: { 'stroke-width': 1.7 } });
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, iconName, className = 'icon-button small') {
    const node = element('button', className);
    node.type = 'button';
    node.title = label;
    node.setAttribute('aria-label', label);
    node.append(icon(iconName));
    return node;
  }

  function preference(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(`rmd-${key}`);
      localStorage.setItem(`rmd-${key}`, value);
    } catch {
      /* Local-file privacy settings can disable storage. */
    }
    return null;
  }

  function plural(count, forms) {
    const last = count % 10;
    const lastTwo = count % 100;
    if (lastTwo >= 11 && lastTwo <= 14) return forms[2];
    if (last === 1) return forms[0];
    if (last >= 2 && last <= 4) return forms[1];
    return forms[2];
  }

  const fileLabel = (count) =>
    `${number.format(count)} ${plural(count, ['файл', 'файла', 'файлов'])}`;
  const wordLabel = (count) =>
    `${number.format(count)} ${plural(count, ['слово', 'слова', 'слов'])}`;
  function sizeLabel(bytes) {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${number.format(Math.round(bytes / 1024))} КБ`;
    return `${number.format(Math.round((bytes / (1024 * 1024)) * 10) / 10)} МБ`;
  }
  const activeDoc = () => state.docs.find((doc) => doc.id === state.activeId);

  function filteredDocs() {
    const docs = state.query
      ? state.docs.filter((doc) => doc.search.includes(state.query))
      : [...state.docs];
    return state.sorted
      ? docs.sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))
      : docs;
  }

  function displayName(doc) {
    const namesakes = state.docs.filter((candidate) => candidate.name === doc.name);
    return namesakes.length > 1 ? `${doc.name} (${namesakes.indexOf(doc) + 1})` : doc.name;
  }

  function showToast(message, undo = null) {
    clearTimeout(toastTimer);
    ui.toastText.textContent = message;
    undoAction = undo;
    ui.toastUndo.hidden = !undo;
    ui.toast.hidden = false;
    toastTimer = setTimeout(
      () => {
        ui.toast.hidden = true;
        undoAction = null;
      },
      undo ? 9000 : 5000,
    );
  }

  function setSidebar(open) {
    document.body.classList.toggle('sidebar-open', open);
    ui.sidebarToggle.setAttribute('aria-expanded', String(open));
    ui.sidebarBackdrop.hidden = !open;
  }

  function renderList() {
    const docs = filteredDocs();
    ui.fileList.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const doc of docs) {
      const row = element('div', `file-item${doc.id === state.activeId ? ' active' : ''}`);
      row.dataset.id = doc.id;
      const open = element('button', 'file-open');
      open.type = 'button';
      open.title = doc.path;
      open.setAttribute('aria-current', doc.id === state.activeId ? 'true' : 'false');
      const fileIcon = icon('file-text');
      fileIcon.classList.add('file-symbol');
      const info = element('span', 'file-info');
      info.append(
        element('span', 'file-name', displayName(doc)),
        element('span', 'file-meta', `${sizeLabel(doc.size)} · ${wordLabel(doc.words)}`),
      );
      open.append(fileIcon, info);
      open.addEventListener('click', () => openDoc(doc.id));
      const close = button(`Закрыть ${displayName(doc)}`, 'x', 'icon-button small file-close');
      close.addEventListener('click', () => closeDoc(doc.id));
      row.append(open, close);
      fragment.append(row);
    }
    ui.fileList.append(fragment);
    ui.fileCount.textContent = state.docs.length;
    ui.emptyList.hidden = docs.length > 0;
    ui.emptyList.querySelector('span').textContent = state.docs.length
      ? 'Ничего не найдено'
      : 'Пока нет файлов';
    ui.searchSummary.hidden = !state.query;
    ui.searchSummary.textContent = `Найдено: ${fileLabel(docs.length)}`;
    ui.clearAll.disabled = !state.docs.length;
    ui.sidebarStatus.textContent = state.docs.length
      ? `${fileLabel(state.docs.length)} · ${sizeLabel(state.docs.reduce((total, doc) => total + doc.size, 0))}`
      : '.md / .markdown';
    icons(ui.fileList);
  }

  function safeMarkdown(doc) {
    if (doc.html !== null) return doc.html;
    try {
      const clean = DOMPurify.sanitize(marked.parse(doc.content, { gfm: true, breaks: false }), {
        USE_PROFILES: { html: true },
        SANITIZE_NAMED_PROPS: true,
        ALLOW_DATA_ATTR: false,
        FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
        FORBID_ATTR: ['style', 'srcset', 'autofocus', 'formaction'],
      });
      // Imported classes must not inherit controls or overlays from the application.
      const template = document.createElement('template');
      template.innerHTML = clean;
      template.content.querySelectorAll('[class]').forEach((node) => {
        const language =
          node.tagName === 'CODE'
            ? Array.from(node.classList).find((name) => /^language-[\w.+#-]+$/.test(name))
            : null;
        node.removeAttribute('class');
        if (language) node.className = language;
      });
      doc.html = template.innerHTML;
    } catch {
      const fallback = element('pre', '', doc.content);
      doc.html = fallback.outerHTML;
    }
    return doc.html;
  }

  function headingSlug(text) {
    return (
      text
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s+/g, '-') || 'section'
    );
  }

  function decodeLink(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function decorateMarkdown(container, doc, prefix) {
    const used = new Set();
    const headings = [];
    container.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading) => {
      const slug = headingSlug(heading.textContent);
      let occurrence = 0;
      let anchor = slug;
      while (used.has(anchor)) anchor = `${slug}-${++occurrence}`;
      used.add(anchor);
      heading.id = `${prefix}-${anchor}`;
      headings.push({
        text: heading.textContent,
        level: Number(heading.tagName[1]),
        id: heading.id,
        anchor,
      });
    });

    container.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href');
      if (href.startsWith('#')) {
        link.addEventListener('click', (event) => {
          event.preventDefault();
          const target = decodeLink(href.slice(1));
          const match = headings.find(
            (heading) => heading.anchor === target || heading.anchor === headingSlug(target),
          );
          if (match)
            document
              .getElementById(match.id)
              ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
      } else if (!/^(?:https?:|mailto:|tel:)/i.test(href)) {
        link.addEventListener('click', (event) => {
          event.preventDefault();
          const path = decodeLink(href.split('#')[0].split('?')[0]);
          const base = doc.path.includes('/')
            ? doc.path.slice(0, doc.path.lastIndexOf('/') + 1)
            : '';
          const resolved = new URL(path, `https://rmd.local/${base}`).pathname.slice(1);
          const match =
            state.docs.find((candidate) => candidate.path === resolved) ||
            state.docs.find((candidate) => candidate.name === path.split('/').pop());
          if (match) {
            openDoc(match.id);
            if (href.includes('#')) {
              const target = decodeLink(href.split('#')[1]);
              requestAnimationFrame(() =>
                document
                  .getElementById(`reader-${headingSlug(target)}`)
                  ?.scrollIntoView({ block: 'start' }),
              );
            }
          } else showToast('Связанный файл не открыт');
        });
      } else {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    });

    container.querySelectorAll('input').forEach((input) => {
      if (input.type === 'checkbox') input.disabled = true;
      else input.remove();
    });
    container.querySelectorAll('img').forEach((img) => {
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener(
        'error',
        () => {
          const label = element(
            'span',
            'image-unavailable',
            img.alt ? `[${img.alt}]` : '[Изображение недоступно]',
          );
          label.title = img.getAttribute('src') || '';
          img.replaceWith(label);
        },
        { once: true },
      );
    });
    container.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code');
      if (!code) return;
      const tools = element('div', 'code-tools');
      const language =
        Array.from(code.classList)
          .find((name) => name.startsWith('language-'))
          ?.slice(9) || 'code';
      const copy = button('Копировать код', 'copy');
      copy.addEventListener('click', () => copyText(code.textContent));
      tools.append(element('span', '', language), copy);
      pre.prepend(tools);
    });
    if (!container.textContent.trim() && !container.querySelector('img,hr,input'))
      container.append(element('p', 'outline-empty', 'Пустой документ'));
    icons(container);
    return headings;
  }

  function renderOutline(headings) {
    ui.outlineLinks.replaceChildren();
    if (!headings.length) {
      ui.outlineLinks.append(element('p', 'outline-empty', 'В документе нет заголовков'));
      return;
    }
    const topLevel = Math.min(...headings.map((heading) => heading.level));
    for (const heading of headings) {
      const link = element(
        'button',
        `outline-link depth-${Math.min(3, heading.level - topLevel + 1)}`,
        heading.text,
      );
      link.addEventListener('click', () =>
        document.getElementById(heading.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
      );
      ui.outlineLinks.append(link);
    }
  }

  function renderSingle() {
    const doc = activeDoc();
    if (!doc) return;
    ui.activeName.textContent = displayName(doc);
    ui.activeName.title = doc.path;
    ui.reader.hidden = state.source;
    ui.source.hidden = !state.source;
    ui.readingLayout.classList.toggle('no-outline', !state.outline || state.source);
    ui.outline.hidden = !state.outline || state.source;
    if (state.source) ui.source.textContent = doc.content || 'Пустой документ';
    else {
      ui.reader.innerHTML = safeMarkdown(doc);
      renderOutline(decorateMarkdown(ui.reader, doc, 'reader'));
    }
    ui.readerScroll.scrollTo({
      top: doc.scroll[state.source ? 'source' : 'rendered'] || 0,
      behavior: 'instant',
    });
  }

  function renderGrid() {
    const docs = filteredDocs();
    ui.documentGrid.querySelectorAll('.card-content').forEach((content) => {
      const doc = state.docs.find((candidate) => candidate.id === content.dataset.document);
      if (doc) doc.scroll[content.dataset.scrollKey] = content.scrollTop;
    });
    const previousCollectionScroll = ui.documentGrid.childElementCount
      ? ui.allPane.scrollTop
      : collectionScroll;
    const restoreScroll = [];
    ui.documentGrid.replaceChildren();
    ui.documentGrid.style.gridTemplateColumns = `repeat(${state.columns}, minmax(0, 1fr))`;
    ui.collectionCount.textContent = fileLabel(docs.length);
    ui.noResults.hidden = docs.length > 0;
    const fragment = document.createDocumentFragment();
    for (const doc of docs) {
      const card = element('section', 'document-card');
      const heading = element('div', 'card-heading');
      const name = element('button', 'card-title', displayName(doc));
      name.title = doc.path;
      name.addEventListener('click', () => openDoc(doc.id));
      const expand = button('Открыть документ', 'maximize-2');
      expand.addEventListener('click', () => openDoc(doc.id));
      const close = button(`Закрыть ${displayName(doc)}`, 'x');
      close.addEventListener('click', () => closeDoc(doc.id));
      heading.append(icon('file-text'), name, expand, close);
      const content = element('article', 'card-content markdown-body');
      const scrollKey = state.source ? 'grid-source' : 'grid-rendered';
      content.dataset.document = doc.id;
      content.dataset.scrollKey = scrollKey;
      content.addEventListener(
        'scroll',
        () => {
          doc.scroll[scrollKey] = content.scrollTop;
          scheduleSave();
        },
        { passive: true },
      );
      restoreScroll.push({ content, position: doc.scroll[scrollKey] || 0 });
      if (state.source)
        content.append(element('pre', 'source-body', doc.content || 'Пустой документ'));
      else {
        content.innerHTML = safeMarkdown(doc);
        decorateMarkdown(content, doc, `grid-${doc.id}`);
      }
      const footer = element('div', 'card-footer');
      footer.append(
        element('span', '', wordLabel(doc.words)),
        element('span', '', sizeLabel(doc.size)),
      );
      card.append(heading, content, footer);
      fragment.append(card);
    }
    ui.documentGrid.append(fragment);
    for (const { content, position } of restoreScroll) content.scrollTop = position;
    ui.allPane.scrollTop = previousCollectionScroll;
    icons(ui.documentGrid);
  }

  function updateStatus() {
    const doc = activeDoc();
    if (!state.docs.length) {
      ui.documentStatus.textContent = 'Нет открытых файлов';
      ui.readingProgress.textContent = 'R.MD';
    } else if (state.view === 'all') {
      const docs = filteredDocs();
      ui.documentStatus.textContent = `${fileLabel(docs.length)} · ${wordLabel(docs.reduce((total, item) => total + item.words, 0))}`;
      ui.readingProgress.textContent = 'Все документы';
    } else if (doc) {
      ui.documentStatus.textContent = `${wordLabel(doc.words)} · ${Math.max(1, Math.ceil(doc.words / 200))} мин чтения · ${sizeLabel(doc.size)}`;
      const height = ui.readerScroll.scrollHeight - ui.readerScroll.clientHeight;
      const progress =
        height > 0 ? Math.min(100, Math.round((ui.readerScroll.scrollTop / height) * 100)) : 100;
      ui.readingProgress.textContent = `${progress}%`;
    }
    if (ui.storageStatus.dataset.saveState === 'error')
      ui.documentStatus.textContent += ' · Не сохранено';
  }

  function render() {
    renderList();
    const hasDocs = state.docs.length > 0;
    ui.emptyState.hidden = hasDocs;
    ui.singlePane.hidden = !hasDocs || state.view !== 'single';
    ui.allPane.hidden = !hasDocs || state.view !== 'all';
    ui.singleView.classList.toggle('selected', state.view === 'single');
    ui.allView.classList.toggle('selected', state.view === 'all');
    ui.singleView.setAttribute('aria-pressed', String(state.view === 'single'));
    ui.allView.setAttribute('aria-pressed', String(state.view === 'all'));
    ui.columnControl.hidden = state.view !== 'all';
    ui.outlineToggle.disabled = !hasDocs || state.view === 'all' || state.source;
    ui.sourceToggle.disabled = !hasDocs;
    ui.sourceToggle.setAttribute('aria-pressed', String(state.source));
    ui.sourceToggle.title = state.source ? 'Отформатированный документ' : 'Исходный Markdown';
    ui.sourceToggle.setAttribute('aria-label', ui.sourceToggle.title);
    ui.outlineToggle.setAttribute('aria-pressed', String(state.outline));
    updateSortControl();
    if (hasDocs) {
      if (state.view === 'single') renderSingle();
      else renderGrid();
    } else {
      ui.reader.replaceChildren();
      ui.source.textContent = '';
      ui.documentGrid.replaceChildren();
      ui.outlineLinks.replaceChildren();
    }
    requestAnimationFrame(updateStatus);
    scheduleSave();
  }

  function saveScroll() {
    const doc = activeDoc();
    if (doc && state.view === 'single')
      doc.scroll[state.source ? 'source' : 'rendered'] = ui.readerScroll.scrollTop;
  }

  function updateSortControl() {
    ui.sortToggle.setAttribute('aria-pressed', String(state.sorted));
    ui.sortToggle.title = state.sorted ? 'Порядок открытия' : 'Сортировать по имени';
    ui.sortToggle.setAttribute('aria-label', ui.sortToggle.title);
  }

  function openDoc(id) {
    saveScroll();
    state.activeId = id;
    state.view = 'single';
    setSidebar(false);
    render();
  }

  function closeDoc(id) {
    saveScroll();
    const index = state.docs.findIndex((doc) => doc.id === id);
    if (index < 0) return;
    const [doc] = state.docs.splice(index, 1);
    if (state.activeId === id)
      state.activeId = state.docs[Math.min(index, state.docs.length - 1)]?.id || null;
    render();
    persistWorkspace(true);
    showToast(`Закрыт ${doc.name}`, () => {
      state.docs.splice(Math.min(index, state.docs.length), 0, doc);
      state.activeId = doc.id;
      render();
      persistWorkspace(true);
    });
  }

  async function loadFiles(files) {
    await ready;
    if (importing) {
      showToast('Дождитесь загрузки файлов');
      return;
    }
    importing = true;
    ui.documentStatus.textContent = 'Открываем документы…';
    const supported = /\.(?:md|markdown|mdown|mkd|mkdn)$/i;
    let rejected = 0;
    let failed = 0;
    let duplicates = 0;
    const accepted = Array.from(files).filter((file) => {
      if (!supported.test(file.name)) {
        rejected++;
        return false;
      }
      if (file.size > 20 * 1024 * 1024) {
        failed++;
        return false;
      }
      return true;
    });
    const loaded = await Promise.all(
      accepted.map(async (file) => {
        try {
          const content = (await file.text()).replace(/^\uFEFF/, '');
          const path = file.webkitRelativePath || file.name;
          return createDocument({
            id: `doc-${++sequence}`,
            name: file.name,
            path,
            size: file.size,
            content,
          });
        } catch {
          failed++;
          return null;
        }
      }),
    );
    let added = 0;
    for (const doc of loaded.filter(Boolean)) {
      if (
        state.docs.some(
          (candidate) => candidate.path === doc.path && candidate.content === doc.content,
        )
      )
        duplicates++;
      else {
        state.docs.push(doc);
        added++;
      }
    }
    if (!state.activeId && state.docs.length) state.activeId = state.docs[0].id;
    if (added && state.query) {
      state.query = '';
      ui.fileSearch.value = '';
    }
    importing = false;
    ui.fileInput.value = '';
    render();
    const saved = added ? await persistWorkspace(true) : true;
    const messages = [];
    if (added) messages.push(`Открыто: ${fileLabel(added)}`);
    if (duplicates) messages.push(`Уже открыто: ${fileLabel(duplicates)}`);
    if (rejected) messages.push(`Пропущено файлов другого формата: ${rejected}`);
    if (failed) messages.push(`Не удалось открыть: ${failed} (лимит — 20 МБ на файл)`);
    if (messages.length && saved) showToast(messages.join('. '));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Код скопирован');
    } catch {
      const field = element('textarea');
      field.value = text;
      field.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.append(field);
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      showToast(copied ? 'Код скопирован' : 'Не удалось скопировать код');
    }
  }

  function setTheme(dark) {
    document.body.classList.toggle('dark', dark);
    const label = dark ? 'Светлая тема' : 'Тёмная тема';
    ui.themeToggle.replaceChildren(icon(dark ? 'sun' : 'moon'));
    ui.themeToggle.title = label;
    ui.themeToggle.setAttribute('aria-label', label);
    icons(ui.themeToggle);
    preference('theme', dark ? 'dark' : 'light');
  }

  function setFont(size) {
    if (workspaceReady) saveScroll();
    state.fontSize = Math.max(12, Math.min(24, size));
    document.documentElement.style.setProperty('--reader-size', `${state.fontSize}px`);
    ui.fontValue.textContent = state.fontSize;
    ui.fontDecrease.disabled = state.fontSize === 12;
    ui.fontIncrease.disabled = state.fontSize === 24;
    preference('font', String(state.fontSize));
    requestAnimationFrame(updateStatus);
    scheduleSave();
  }

  document
    .querySelectorAll('.add-files')
    .forEach((node) => node.addEventListener('click', () => ui.fileInput.click()));
  ui.fileInput.addEventListener('change', () => loadFiles(ui.fileInput.files));
  ui.singleView.addEventListener('click', () => {
    state.view = 'single';
    render();
  });
  ui.allView.addEventListener('click', () => {
    saveScroll();
    state.view = 'all';
    render();
    setSidebar(false);
  });
  ui.fileSearch.addEventListener('input', () => {
    state.query = ui.fileSearch.value.trim().toLocaleLowerCase('ru');
    renderList();
    if (state.view === 'all') renderGrid();
    updateStatus();
    scheduleSave();
  });
  ui.sortToggle.addEventListener('click', () => {
    state.sorted = !state.sorted;
    updateSortControl();
    renderList();
    if (state.view === 'all') renderGrid();
    scheduleSave();
  });
  ui.clearAll.addEventListener('click', () => {
    saveScroll();
    const previous = [...state.docs];
    const activeId = state.activeId;
    state.docs = [];
    state.activeId = null;
    state.query = '';
    ui.fileSearch.value = '';
    render();
    persistWorkspace(true);
    showToast('Все документы закрыты', () => {
      const existing = new Set(state.docs.map((doc) => doc.id));
      state.docs = [...previous.filter((doc) => !existing.has(doc.id)), ...state.docs];
      state.activeId = activeId;
      render();
      persistWorkspace(true);
    });
  });
  ui.columns.addEventListener('change', () => {
    state.columns = Number(ui.columns.value);
    renderGrid();
    preference('columns', String(state.columns));
    scheduleSave();
  });
  ui.fontDecrease.addEventListener('click', () => setFont(state.fontSize - 1));
  ui.fontIncrease.addEventListener('click', () => setFont(state.fontSize + 1));
  ui.sourceToggle.addEventListener('click', () => {
    saveScroll();
    state.source = !state.source;
    render();
  });
  ui.outlineToggle.addEventListener('click', () => {
    saveScroll();
    state.outline = !state.outline;
    render();
  });
  ui.themeToggle.addEventListener('click', () =>
    setTheme(!document.body.classList.contains('dark')),
  );
  ui.sidebarToggle.addEventListener('click', () =>
    setSidebar(!document.body.classList.contains('sidebar-open')),
  );
  ui.sidebarBackdrop.addEventListener('click', () => setSidebar(false));
  ui.toastClose.addEventListener('click', () => {
    ui.toast.hidden = true;
    clearTimeout(toastTimer);
  });
  ui.toastUndo.addEventListener('click', () => {
    const action = undoAction;
    undoAction = null;
    ui.toast.hidden = true;
    clearTimeout(toastTimer);
    action?.();
  });
  ui.readerScroll.addEventListener(
    'scroll',
    () => {
      saveScroll();
      updateStatus();
      scheduleSave();
    },
    { passive: true },
  );
  ui.allPane.addEventListener(
    'scroll',
    () => {
      collectionScroll = ui.allPane.scrollTop;
      scheduleSave();
    },
    { passive: true },
  );
  ui.downloadFile.addEventListener('click', () => {
    const doc = activeDoc();
    if (!doc) return;
    const url = URL.createObjectURL(
      new Blob([doc.content], { type: 'text/markdown;charset=utf-8' }),
    );
    const link = element('a');
    link.href = url;
    link.download = doc.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.querySelector('.brand').addEventListener('click', (event) => {
    event.preventDefault();
    if (state.docs.length) {
      state.view = 'single';
      render();
    }
  });
  document.addEventListener('keydown', (event) => {
    const typing =
      /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable;
    if (event.key === 'Escape') {
      setSidebar(false);
      ui.toast.hidden = true;
      if (event.target === ui.fileSearch) {
        ui.fileSearch.value = '';
        ui.fileSearch.dispatchEvent(new Event('input'));
        ui.fileSearch.blur();
      }
    }
    if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (innerWidth <= 640) setSidebar(true);
      ui.fileSearch.focus();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      ui.fileInput.click();
    }
  });
  document.addEventListener('dragenter', (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    dragDepth++;
    ui.dropOverlay.hidden = false;
  });
  document.addEventListener('dragover', (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) ui.dropOverlay.hidden = true;
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    ui.dropOverlay.hidden = true;
    if (event.dataTransfer?.files.length) loadFiles(event.dataTransfer.files);
  });
  window.addEventListener('blur', () => {
    dragDepth = 0;
    ui.dropOverlay.hidden = true;
  });
  window.addEventListener('resize', () => {
    if (innerWidth > 640) setSidebar(false);
    updateStatus();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistWorkspace();
  });
  window.addEventListener('pagehide', () => {
    persistWorkspace();
  });

  icons();
  setTheme(preference('theme') === 'dark');
  const storedFont = Number(preference('font'));
  setFont(storedFont >= 12 && storedFont <= 24 ? storedFont : 16);
  const storedColumns = Number(preference('columns'));
  state.columns = [1, 2, 3].includes(storedColumns) ? storedColumns : 2;
  ui.columns.value = String(state.columns);
  render();
  const ready = restoreWorkspace();
})();
