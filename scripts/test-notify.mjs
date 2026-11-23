/**
 * Уведомления (CW5.4, ADR 0081): рабочий стол и webhook.
 */
import { notifySettings, webhookPayload, createNotifier } from '../electron/lib/notify.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 300)}`);
  }
}

console.log('[1] настройки');
let cfg = notifySettings({});
check('по умолчанию: рабочий стол — все, webhook — нет без адреса', cfg.desktop.length === 6 && cfg.webhook.length === 0 && cfg.webhookUrl === '');
cfg = notifySettings({ notifications: { webhookUrl: 'https://hooks.example/x' } });
check('с адресом: webhook — готово, ошибка, плановая', cfg.webhook.join() === 'done,error,scheduled');
check('http без s — не принимается', notifySettings({ notifications: { webhookUrl: 'http://evil/x' } }).webhookUrl === '');
check('выключено — рабочий стол пуст', notifySettings({ notifications: { enabled: false } }).desktop.length === 0);
check('неизвестные виды отбрасываются', notifySettings({ notifications: { desktop: ['done', 'wat'] } }).desktop.join() === 'done');
const p = webhookPayload({ kind: 'error', title: 'Ошибка: отчёт', body: '429' });
check('тело webhook: text и content', p.text === 'MAI Code · ошибка прогона: Ошибка: отчёт — 429' && p.content === p.text);

console.log('[2] доставка');
const shown = [];
const clicks = [];
class FakeNotification {
  static isSupported() {
    return true;
  }
  constructor(o) {
    this.o = o;
    this.handlers = {};
  }
  on(ev, fn) {
    this.handlers[ev] = fn;
  }
  show() {
    shown.push(this);
  }
}
const posts = [];
let focused = true;
let settings = { notifications: { webhookUrl: 'https://hooks.example/x' } };
const logs = [];
const notify = createNotifier({
  Notification: FakeNotification,
  getSettings: () => settings,
  isFocused: () => focused,
  onClick: (x) => clicks.push(x),
  fetch: async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return { ok: url.includes('example'), status: url.includes('example') ? 200 : 500 };
  },
  log: (t) => logs.push(t),
});
let r = await notify('done', { title: 'Готово: отчёт', body: 'сводка готова', sessionId: 's1' });
check('окно в фокусе — без рабочего стола, webhook уходит', !r.desktop && r.webhook && shown.length === 0 && posts.length === 1 && posts[0].body.text.includes('Готово: отчёт'));
focused = false;
r = await notify('approval', { title: 'Нужно подтверждение: отчёт', body: 'Записать файл', sessionId: 's1' });
check('окно не в фокусе — на рабочем столе; approval в webhook по умолчанию не уходит', r.desktop && !r.webhook && shown.at(-1).o.title === 'Нужно подтверждение: отчёт' && posts.length === 1);
shown.at(-1).handlers.click();
check('клик — открыть чат', clicks.at(-1)?.sessionId === 's1');
r = await notify('approval', { title: 'Нужно подтверждение: отчёт', body: 'x', sessionId: 's1' });
check('то же в течение 10 с — не повторяется', r.deduped === true && shown.length === 1);
settings = { notifications: { desktop: ['error'], webhookUrl: 'https://down.test/x', webhook: ['error'] } };
r = await notify('done', { title: 'другое', sessionId: 's2' });
check('вид выключен — ничего', !r.desktop && !r.webhook);
r = await notify('error', { title: 'Ошибка: x', sessionId: 's3' });
check('webhook ответил ошибкой — в журнал, без падения', r.desktop && !r.webhook && logs.some((t) => /HTTP 500/.test(t)));

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
