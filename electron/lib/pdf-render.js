/**
 * HTML → PDF через Chromium Electron (CW2.4, ADR 0067). Скрытое окно без
 * JavaScript и без сети: CSP `default-src 'none'` вставляется в любую страницу
 * (внешние ресурсы не запрашиваются вовсе), а сетевые и файловые запросы
 * отдельной сессии ещё и отменяются — на случай, если CSP обойдут. Переходы
 * запрещены.
 * A4. `BrowserWindow` передаётся снаружи — модуль без импорта Electron.
 */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_r, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer));
}

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`;

/** Вставляет CSP в начало документа: после <head>, иначе после doctype. */
export function withCsp(html) {
  const text = String(html);
  const head = text.match(/<head[^>]*>/i);
  if (head) return text.replace(head[0], `${head[0]}${CSP}`);
  const doctype = text.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) return `${doctype[0]}${CSP}${text.slice(doctype[0].length)}`;
  return `${CSP}${text}`;
}

export async function renderPdf(BrowserWindow, html, { timeoutMs = 30_000 } = {}) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'mai-pdf-render' },
  });
  try {
    // Фильтр без data: — сама страница через перехват не идёт.
    const urls = ['http', 'https', 'ws', 'wss', 'ftp', 'file'].map((scheme) => `${scheme}://*/*`);
    win.webContents.session.webRequest.onBeforeRequest({ urls }, (_details, cb) => cb({ cancel: true }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    const url = `data:text/html;charset=utf-8;base64,${Buffer.from(withCsp(html), 'utf8').toString('base64')}`;
    const load = win.loadURL(url);
    await withTimeout(load, timeoutMs, 'PDF: страница не загрузилась');
    return await withTimeout(win.webContents.printToPDF({ pageSize: 'A4', printBackground: true }), timeoutMs, 'PDF: печать не завершилась');
  } finally {
    await closeWindow(win);
  }
}

/** Закрываем штатно и ждём, пока окно уйдёт (destroy — запасной путь). */
function closeWindow(win) {
  return new Promise((resolve) => {
    if (win.isDestroyed()) return resolve();
    const timer = setTimeout(() => {
      if (!win.isDestroyed()) win.destroy();
      resolve();
    }, 2000);
    win.once('closed', () => {
      clearTimeout(timer);
      resolve();
    });
    win.close();
  });
}

/**
 * HTML → картинки страниц для самопроверки агентом (CW2.5, ADR 0068).
 * Окно вне экрана той же изоляции, что и для PDF: CSP запрещает скрипты
 * страницы, JavaScript включён только чтобы main измерил высоту документа.
 * Страница режется на куски по высоте A4 (при ширине 794 px), не больше maxPages.
 * @returns {Promise<{ pages: Buffer[], total: number }>} PNG и сколько страниц всего
 */
export async function renderPng(BrowserWindow, html, { width = 794, pageHeight = 1123, maxPages = 4, timeoutMs = 30_000 } = {}) {
  const win = new BrowserWindow({
    show: false,
    width,
    height: pageHeight,
    useContentSize: true,
    webPreferences: { offscreen: true, javascript: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'mai-pdf-render' },
  });
  try {
    const urls = ['http', 'https', 'ws', 'wss', 'ftp', 'file'].map((scheme) => `${scheme}://*/*`);
    win.webContents.session.webRequest.onBeforeRequest({ urls }, (_details, cb) => cb({ cancel: true }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const url = `data:text/html;charset=utf-8;base64,${Buffer.from(withCsp(html), 'utf8').toString('base64')}`;
    await withTimeout(win.loadURL(url), timeoutMs, 'Превью: страница не загрузилась');
    const height = Math.max(1, Number(await win.webContents.executeJavaScript('document.documentElement.scrollHeight')) || pageHeight);
    const total = Math.ceil(height / pageHeight);
    const shown = Math.min(total, maxPages);
    win.setContentSize(width, Math.min(height, shown * pageHeight));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const pages = [];
    for (let i = 0; i < shown; i += 1) {
      const y = i * pageHeight;
      const image = await withTimeout(win.webContents.capturePage({ x: 0, y, width, height: Math.min(pageHeight, height - y) }), timeoutMs, 'Превью: снимок не получен');
      pages.push(image.toPNG());
    }
    return { pages, total };
  } finally {
    await closeWindow(win);
  }
}
