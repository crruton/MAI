/**
 * Браузер агента (CW4.1, CW4.2, ADR 0069). Под Electron, с локальным сервером.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { app, BrowserWindow } from 'electron';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`);
  }
}
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-browser-'));
app.setPath('userData', path.join(sandbox, 'data'));
app.on('window-all-closed', () => {});

const PAGES = {
  '/': '<!doctype html><title>Главная</title><h1>Магазин</h1><p>Добро пожаловать</p><a href="/about">О нас</a><form action="/search"><input name="q" placeholder="Поиск"><button>Найти</button></form><a href="/login">Войти</a><a href="/cart">Корзина</a><a href="javascript:alert(1)">js</a>',
  '/about': '<!doctype html><title>О нас</title><p>Мы продаём книги</p>',
  '/login': '<!doctype html><title>Вход</title><form action="/done"><label>Логин <input name="login"></label><label>Пароль <input type="password" name="pwd"></label><input name="cardnumber" placeholder="Номер карты"><button>Войти</button></form>',
  '/cart': '<!doctype html><title>Корзина</title><p>Книга — 500 ₽</p><button onclick="document.title=\'Оплачено\'">Оплатить заказ</button><button onclick="document.title=\'Удалено\'">Удалить</button>',
};

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/search') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><title>Результаты</title><p>Найдено по запросу: ${url.searchParams.get('q')}</p>`);
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGES[url.pathname] || '<p>404</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { createAgentBrowser, isSensitiveField, isPaymentAction, normalizeUrl } = await import('../electron/lib/browser-agent.js');
    const { browserTools } = await import('../electron/lib/tools/browser.js');
    const { toolEntry, runToolCall } = await import('../electron/lib/tool-runner.js');
    const { browserSiteRules, mergeRules } = await import('../electron/lib/policy.js');

    console.log('[1] правила полей и адресов');
    check('пароль, код, карта — чувствительные', isSensitiveField({ type: 'password' }) && isSensitiveField({ autocomplete: 'one-time-code' }) && isSensitiveField({ autocomplete: 'cc-number' }) && isSensitiveField({ name: 'cvv' }) && isSensitiveField({ placeholder: 'Номер карты' }));
    check('обычное поле — нет', !isSensitiveField({ type: 'text', name: 'q', placeholder: 'Поиск' }));
    check('оплата узнаётся', Boolean(isPaymentAction({ text: 'Оплатить заказ' }) && isPaymentAction({ text: 'Place order' }) && isPaymentAction({ submits: true, formHasSensitive: true })));
    check('обычная кнопка — не оплата', !isPaymentAction({ text: 'Удалить' }) && !isPaymentAction({ text: 'Найти', submits: true }));
    let threw = '';
    try {
      normalizeUrl('file:///etc/passwd');
    } catch (err) {
      threw = err.message;
    }
    check('file: не открывается, адрес без схемы — https', /только http/.test(threw) && normalizeUrl('example.com/x') === 'https://example.com/x', threw);

    console.log('[2] настоящий браузер');
    const browser = createAgentBrowser({ BrowserWindow, show: false, partition: `mai-browser-test-${Date.now()}` });
    let snap = await browser.open(`${base}/`);
    check('снимок: заголовок, текст, элементы с номерами', /Страница: Главная/.test(snap) && /Добро пожаловать/.test(snap) && /\[1\] ссылка «О нас»/.test(snap) && /поле text name=q \(Поиск\)/.test(snap), snap);
    check('хост текущей страницы', browser.host() === '127.0.0.1');
    snap = await browser.click(1);
    check('клик по ссылке — новая страница', /Мы продаём книги/.test(snap), snap);
    await browser.open(`${base}/`);
    const q = Number(/\[(\d+)\] поле text name=q/.exec(await browser.read())[1]);
    const typed = await browser.type(q, 'Толстой', { submit: true });
    check('ввод и отправка формы', /Найдено по запросу: Толстой/.test(typed.snapshot), typed.snapshot);
    snap = await browser.open(`${base}/login`);
    check('поле пароля помечено «вводит пользователь»', /name=pwd.*вводит пользователь/.test(snap), snap);
    const pwd = Number(/\[(\d+)\] поле password/.exec(snap)[1]);
    const refused = await browser.type(pwd, 'secret');
    const value = await BrowserWindow.getAllWindows().find((w) => /\/login/.test(w.webContents.getURL())).webContents.executeJavaScript('document.querySelector("[name=pwd]").value');
    check('пароль агент не вводит', Boolean(refused.refused) && value === '', JSON.stringify(refused));
    const card = Number(/\[(\d+)\] поле text name=cardnumber/.exec(snap)[1]);
    check('номер карты тоже', Boolean((await browser.type(card, '4111')).refused));
    const shot = await browser.screenshot();
    check('снимок экрана — PNG', shot.subarray(1, 4).toString() === 'PNG');

    console.log('[3] разрешения: сайты и оплата');
    const entries = Object.fromEntries(browserTools.map((t) => [t.schema.function.name, toolEntry(t.schema, { source: 'builtin', run: t.run, precheck: t.precheck, assess: t.assess })]));
    const asked = [];
    const approve = async (req) => {
      asked.push(req);
      return { allow: false, message: 'нет' };
    };
    const ctx = { projectDir: sandbox, browser, previewDir: path.join(sandbox, 'prev'), vision: () => true };
    await browser.open(`${base}/cart`);
    const cartSnap = await browser.read();
    const payRef = Number(/\[(\d+)\] кнопка «Оплатить заказ»/.exec(cartSnap)[1]);
    const delRef = Number(/\[(\d+)\] кнопка «Удалить»/.exec(cartSnap)[1]);
    const allowSite = { getMode: () => 'manual', getRules: () => mergeRules(browserSiteRules({ allow: ['127.0.0.1'] })) };
    let out = await runToolCall({ entry: entries.browser_click, args: { ref: delRef }, ctx, policy: allowSite, approve });
    check('разрешённый сайт — действие без вопроса', out.ok !== false && asked.length === 0, out.content);
    asked.length = 0;
    out = await runToolCall({ entry: entries.browser_click, args: { ref: payRef }, ctx, policy: allowSite, approve });
    check('оплата — вопрос даже на разрешённом сайте', asked.length === 1 && asked[0].decisionSource === 'browser-payment' && asked[0].recommended === 'deny' && asked[0].suggestions.length === 0 && out.ok === false, JSON.stringify(asked[0] || out));
    asked.length = 0;
    out = await runToolCall({ entry: entries.browser_click, args: { ref: payRef }, ctx, policy: { getMode: () => 'bypass', getRules: () => ({}) }, approve });
    check('оплата — вопрос и в «Без вопросов»', asked.length === 1, out.content);
    out = await runToolCall({ entry: entries.browser_click, args: { ref: payRef }, ctx, policy: { getMode: () => 'dontAsk', getRules: () => mergeRules(browserSiteRules({ allow: ['127.0.0.1'] })) }, approve });
    check('«Не спрашивать» — оплата запрещена', out.ok === false && /Без пользователя нельзя/.test(out.content), out.content);
    const title = await BrowserWindow.getAllWindows().find((w) => /\/cart/.test(w.webContents.getURL())).webContents.getTitle();
    check('кнопка оплаты так и не нажата', title !== 'Оплачено', title);
    asked.length = 0;
    out = await runToolCall({ entry: entries.browser_open, args: { url: `${base}/about` }, ctx, policy: { getMode: () => 'manual', getRules: () => ({}) }, approve });
    check('новый сайт в ручном режиме — вопрос с правилом на домен', asked.length === 1 && asked[0].subject === '127.0.0.1' && asked[0].suggestions[0] === 'browser_*(127.0.0.1)', JSON.stringify(asked[0]));
    out = await runToolCall({ entry: entries.browser_open, args: { url: `${base}/about` }, ctx, policy: { getMode: () => 'bypass', getRules: () => mergeRules(browserSiteRules({ block: ['127.0.0.1'] })) }, approve });
    check('сайт под запретом — отказ даже в «Без вопросов»', out.ok === false && /Запрещено правилом/.test(out.content), out.content);
    out = await runToolCall({ entry: entries.browser_type, args: { ref: 1, text: 'x' }, ctx: { projectDir: sandbox }, policy: { getMode: () => 'bypass', getRules: () => ({}) }, approve });
    check('без браузера — понятный отказ', /только в приложении/.test(out.content), out.content);
    out = await runToolCall({ entry: entries.browser_screenshot, args: {}, ctx, policy: { getMode: () => 'manual', getRules: () => ({}) }, approve });
    check('browser_screenshot — картинка для модели без вопроса', Array.isArray(out.images) && fs.existsSync(out.images[0]), out.content);
    browser.close();
  } catch (err) {
    fail += 1;
    console.log(`  FAIL исключение: ${err?.stack || err}`);
  }
  server.close();
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* кеш */
  }
  console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
  app.exit(fail ? 1 : 0);
});
