/**
 * Браузер агента (CW4.1, ADR 0069): отдельное окно Chromium, которым агент
 * управляет инструментами browser_*. Модуль не импортирует Electron —
 * `BrowserWindow` передаёт main (и тест).
 *
 * - Своя постоянная сессия `persist:mai-browser`: входы на сайты, которые
 *   пользователь сделал сам в этом окне, сохраняются; с его основным браузером
 *   и с окном приложения она не пересекается.
 * - Только http(s): file:, data:, javascript: и прочие схемы не открываются,
 *   новые окна страница не создаёт (ссылка открывается в этом же окне).
 * - Снимок страницы — текст и пронумерованные элементы управления; агент
 *   кликает и вводит по номеру. Номера ставятся атрибутом `data-mai-ref`.
 * - Пароли, коды и данные карт агент не вводит никогда: поле опознаётся по
 *   типу, autocomplete и имени; окно показывается пользователю.
 */

const MAX_TEXT = 12_000;
const MAX_ELEMENTS = 150;

/** Поле, которое агент не заполняет: пароль, одноразовый код, карта, счёт. */
export function isSensitiveField(info = {}) {
  const type = String(info.type || '').toLowerCase();
  const auto = String(info.autocomplete || '').toLowerCase();
  const name = `${info.name || ''} ${info.id || ''} ${info.label || ''} ${info.placeholder || ''}`.toLowerCase();
  if (type === 'password') return 'пароль';
  if (/(^|\s)(current-password|new-password|one-time-code)(\s|$)/.test(auto)) return 'пароль или код';
  if (/(^|\s)cc-/.test(auto)) return 'данные карты';
  if (/(card.?num|cardnumber|cc.?num|cvc|cvv|csc|security.?code|iban|номер карты|срок действия карты|pin\b|пин.?код|парол|password|passcode|one.?time|смс.?код|sms.?code)/.test(name)) return 'пароль, код или данные карты';
  return null;
}

/** Действие, которое списывает деньги или что-то подтверждает от имени пользователя. */
const PAYMENT_RE = /(оплат|заплат|купить|покупк|оформить заказ|подтвердить заказ|перевести|перевод средств|\bpay\b|pay now|buy|purchase|checkout|place order|confirm (order|payment)|subscribe|donate|пожертв|подписаться на тариф)/i;

export function isPaymentAction(info = {}) {
  const text = `${info.text || ''} ${info.value || ''} ${info.label || ''}`.trim();
  if (PAYMENT_RE.test(text)) return `похоже на оплату или покупку: «${text.slice(0, 80)}»`;
  if (info.formHasSensitive && info.submits) return 'отправка формы с паролем или данными карты';
  return null;
}

/** Разрешённый адрес: только http(s). */
export function normalizeUrl(raw) {
  let text = String(raw || '').trim();
  if (!text) throw new Error('Нужен адрес страницы');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  const url = new URL(text);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Схема ${url.protocol} не открывается — только http и https`);
  return url.toString();
}

/* Скрипт снимка выполняется в странице. Он нумерует видимые элементы
 * управления и возвращает текст страницы. Страница может его обмануть — поэтому
 * всё, что он вернул, для агента данные, а проверка полей повторяется при вводе. */
const SNAPSHOT_SCRIPT = `(() => {
  const MAX_TEXT = ${MAX_TEXT}, MAX_ELEMENTS = ${MAX_ELEMENTS};
  document.querySelectorAll('[data-mai-ref]').forEach((el) => el.removeAttribute('data-mai-ref'));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const labelOf = (el) => {
    if (el.labels && el.labels[0]) return el.labels[0].innerText.trim();
    return (el.getAttribute('aria-label') || '').trim();
  };
  const items = [];
  const selector = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [contenteditable=true]';
  for (const el of document.querySelectorAll(selector)) {
    if (items.length >= MAX_ELEMENTS) break;
    if (!visible(el)) continue;
    const ref = items.length + 1;
    el.setAttribute('data-mai-ref', String(ref));
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    items.push({ ref, tag, type: el.type || '', name: el.name || '', id: el.id || '', placeholder: el.placeholder || '', label: labelOf(el).slice(0, 80), text, href: tag === 'a' ? el.href : '', checked: el.checked === true });
  }
  const body = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { title: document.title, url: location.href, text: body.slice(0, MAX_TEXT), truncated: body.length > MAX_TEXT, items };
})()`;

/* Сведения об одном элементе по номеру — для проверки перед действием. */
const ELEMENT_SCRIPT = (ref) => `(() => {
  const el = document.querySelector('[data-mai-ref="${Number(ref)}"]');
  if (!el) return null;
  const form = el.form || el.closest('form');
  const sensitive = (f) => f && f.type === 'password' || /(^|\\s)(cc-|current-password|new-password|one-time-code)/.test(f.autocomplete || '');
  const tag = el.tagName.toLowerCase();
  return {
    tag, type: el.type || '', name: el.name || '', id: el.id || '', autocomplete: el.autocomplete || el.getAttribute('autocomplete') || '',
    placeholder: el.placeholder || '', label: (el.labels && el.labels[0] ? el.labels[0].innerText : el.getAttribute('aria-label') || '').trim().slice(0, 80),
    text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120), value: tag === 'input' && /submit|button/.test(el.type) ? el.value : '',
    submits: tag === 'button' ? (el.type || 'submit') === 'submit' && !!form : tag === 'input' && /submit|image/.test(el.type),
    formHasSensitive: !!form && Array.from(form.elements || []).some(sensitive),
    editable: tag === 'textarea' || tag === 'select' || el.isContentEditable || (tag === 'input' && !/^(button|submit|reset|image|checkbox|radio|file|hidden)$/.test(el.type)),
  };
})()`;

function describeItem(item) {
  const bits = [];
  if (item.tag === 'a') bits.push(`ссылка «${item.text || item.label || item.href}»${item.href ? ` → ${item.href}` : ''}`);
  else if (item.tag === 'button' || item.type === 'submit' || item.type === 'button') bits.push(`кнопка «${item.text || item.label || item.name}»`);
  else if (item.tag === 'select') bits.push(`список ${item.label || item.name || item.id}`.trim());
  else if (item.type === 'checkbox' || item.type === 'radio') bits.push(`${item.type === 'checkbox' ? 'флажок' : 'переключатель'} «${item.label || item.name}»${item.checked ? ' ✓' : ''}`);
  else bits.push(`поле ${item.type || item.tag}${item.label ? ` «${item.label}»` : ''}${item.name ? ` name=${item.name}` : ''}${item.placeholder ? ` (${item.placeholder})` : ''}${isSensitiveField(item) ? ' — вводит пользователь' : ''}`);
  return `[${item.ref}] ${bits.join(' ')}`;
}

export function formatSnapshot(snap) {
  if (!snap) return 'Страница не открыта — browser_open';
  const lines = [`Страница: ${snap.title || '(без заголовка)'}`, `Адрес: ${snap.url}`, '', snap.text || '(текста нет)'];
  if (snap.truncated) lines.push('… текст обрезан');
  lines.push('', `Элементы (${snap.items.length}):`, ...snap.items.map(describeItem));
  return lines.join('\n');
}

/**
 * @param {object} options
 * @param {Function} options.BrowserWindow
 * @param {boolean} [options.show=true] показывать окно пользователю
 * @param {string} [options.partition='persist:mai-browser']
 */
export function createAgentBrowser({ BrowserWindow, show = true, partition = 'persist:mai-browser', timeoutMs = 30_000 } = {}) {
  let win = null;

  const ensure = () => {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 800,
      title: 'Браузер агента — MAI',
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
    });
    win.setMenuBarVisibility?.(false);
    // Новые окна — в этом же окне, и только http(s).
    win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        win.loadURL(normalizeUrl(url)).catch(() => {});
      } catch {
        /* схема не разрешена */
      }
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      if (!/^https?:/i.test(url)) event.preventDefault();
    });
    // Разрешения сайтов (камера, уведомления, геолокация…) — нет.
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    win.webContents.session.on('will-download', (event) => event.preventDefault());
    win.on('page-title-updated', (event) => event.preventDefault());
    win.on('closed', () => {
      win = null;
    });
    return win;
  };

  const reveal = () => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive?.();
  };

  const waitIdle = async (w) => {
    const started = Date.now();
    while (w.webContents.isLoading() && Date.now() - started < timeoutMs) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 250));
  };

  const run = (script) => win.webContents.executeJavaScript(script, true);

  const snapshot = async () => {
    if (!win || win.isDestroyed() || !win.webContents.getURL()) return null;
    return run(SNAPSHOT_SCRIPT);
  };

  const element = async (ref) => {
    if (!win || win.isDestroyed()) throw new Error('Страница не открыта — browser_open');
    const info = await run(ELEMENT_SCRIPT(ref));
    if (!info) throw new Error(`Элемента [${ref}] нет — обнови снимок browser_read`);
    return info;
  };

  return {
    /** Хост текущей страницы — предмет правил для browser_* (CW4.2). */
    host() {
      try {
        return win && !win.isDestroyed() ? new URL(win.webContents.getURL()).hostname : '';
      } catch {
        return '';
      }
    },
    url: () => (win && !win.isDestroyed() ? win.webContents.getURL() : ''),
    async open(raw) {
      const url = normalizeUrl(raw);
      const w = ensure();
      if (show) reveal();
      await w.loadURL(url).catch((err) => {
        // Переход внутри загрузки (редирект, якорь) — не ошибка.
        if (!/ERR_ABORTED/.test(String(err?.message))) throw err;
      });
      await waitIdle(w);
      return formatSnapshot(await snapshot());
    },
    async read() {
      return formatSnapshot(await snapshot());
    },
    element,
    async click(ref) {
      await element(ref);
      await run(`(() => { const el = document.querySelector('[data-mai-ref="${Number(ref)}"]'); el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
      await waitIdle(win);
      return formatSnapshot(await snapshot());
    },
    async type(ref, text, { submit = false } = {}) {
      const info = await element(ref);
      const sensitive = isSensitiveField(info);
      if (sensitive) {
        if (show) {
          reveal();
          win.focus?.();
        }
        return { refused: sensitive };
      }
      if (!info.editable) throw new Error(`[${ref}] — не поле ввода (${info.tag}${info.type ? ` ${info.type}` : ''})`);
      if (info.tag === 'select') {
        const ok = await run(`(() => { const el = document.querySelector('[data-mai-ref="${Number(ref)}"]'); const want = ${JSON.stringify(String(text))}.toLowerCase(); const opt = Array.from(el.options).find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want); if (!opt) return false; el.value = opt.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        if (!ok) throw new Error(`В списке [${ref}] нет варианта «${text}»`);
      } else {
        await run(`(() => { const el = document.querySelector('[data-mai-ref="${Number(ref)}"]'); el.scrollIntoView({ block: 'center' }); el.focus(); if ('select' in el) el.select(); return true; })()`);
        // insertText — как ввод с клавиатуры: срабатывают обработчики страницы.
        await win.webContents.insertText(String(text));
        if (submit) {
          await run(`(() => { const el = document.querySelector('[data-mai-ref="${Number(ref)}"]'); const form = el.form || el.closest('form'); if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return true; } el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return false; })()`);
          await waitIdle(win);
        }
      }
      return { snapshot: formatSnapshot(await snapshot()) };
    },
    async screenshot() {
      if (!win || win.isDestroyed() || !win.webContents.getURL()) throw new Error('Страница не открыта — browser_open');
      const image = await win.webContents.capturePage();
      return image.toPNG();
    },
    show() {
      ensure();
      reveal();
      win.focus?.();
    },
    close() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}
