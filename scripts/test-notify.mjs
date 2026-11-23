/**
 * Уведомления (CW5.4, ADR 0081): рабочий стол и каналы мессенджеров.
 */
import { notifySettings, webhookPayload, createNotifier, channelRequest, normalizeChannel } from '../electron/lib/notify.js';

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
const ev = { kind: 'done', title: 'Готово: отчёт', body: 'сводка' };
const text = 'MAI Code · агент закончил: Готово: отчёт — сводка';

console.log('[1] настройки');
let cfg = notifySettings({});
check('по умолчанию: рабочий стол — все, каналов нет', cfg.desktop.length === 6 && cfg.channels.length === 0);
check('выключено — рабочий стол пуст', notifySettings({ notifications: { enabled: false } }).desktop.length === 0);
cfg = notifySettings({ notifications: { webhookUrl: 'https://hooks.example/x', webhook: ['error'] } });
check('старый webhookUrl — канал webhook с его событиями', cfg.channels.length === 1 && cfg.channels[0].type === 'webhook' && cfg.channels[0].kinds.join() === 'error');
check('http без s — не канал', notifySettings({ notifications: { webhookUrl: 'http://evil/x' } }).channels.length === 0);
check('канал без обязательных полей или выключенный — не используется', notifySettings({ notifications: { channels: [{ type: 'telegram', token: 't' }, { type: 'max', token: 't', chatId: '1', enabled: false }, { type: 'wat' }] } }).channels.length === 0);
check('WhatsApp: номер с + нормализуется, кривой — отказ', normalizeChannel({ type: 'whatsapp', token: 't', phoneNumberId: '123', to: '+79001234567' }).to === '79001234567' && normalizeChannel({ type: 'whatsapp', token: 't', phoneNumberId: '123', to: 'abc' }) === null);
check('по умолчанию события канала — готово, ошибка, плановая', normalizeChannel({ type: 'rocketchat', url: 'https://rc/hooks/x' }).kinds.join() === 'done,error,scheduled');

console.log('[2] запросы каналов');
let r = channelRequest(normalizeChannel({ type: 'telegram', token: '123:ABC', chatId: '-100500' }), ev);
check('Telegram: sendMessage с chat_id и текстом', r.url === 'https://api.telegram.org/bot123%3AABC/sendMessage' && JSON.parse(r.init.body).chat_id === '-100500' && JSON.parse(r.init.body).text === text, r.url);
r = channelRequest(normalizeChannel({ type: 'max', token: 'maxtok', chatId: '777' }), ev);
check('MAX: POST /messages?chat_id, токен в Authorization без Bearer', r.url === 'https://platform-api2.max.ru/messages?chat_id=777' && r.init.headers.Authorization === 'maxtok' && JSON.parse(r.init.body).text === text, JSON.stringify(r));
r = channelRequest(normalizeChannel({ type: 'max', token: 't', chatId: '42', target: 'user', apiBase: 'https://platform-api.max.ru/' }), ev);
check('MAX: user_id и свой адрес API', r.url === 'https://platform-api.max.ru/messages?user_id=42', r.url);
r = channelRequest(normalizeChannel({ type: 'whatsapp', token: 'wa', phoneNumberId: '1055', to: '79001234567' }), ev);
let body = JSON.parse(r.init.body);
check('WhatsApp: Cloud API, Bearer, текст', r.url === 'https://graph.facebook.com/v21.0/1055/messages' && r.init.headers.Authorization === 'Bearer wa' && body.messaging_product === 'whatsapp' && body.type === 'text' && body.text.body === text && body.to === '79001234567');
r = channelRequest(normalizeChannel({ type: 'whatsapp', token: 'wa', phoneNumberId: '1055', to: '79001234567', template: 'mai_notice', lang: 'ru' }), ev);
body = JSON.parse(r.init.body);
check('WhatsApp: шаблон вне 24-часового окна', body.type === 'template' && body.template.name === 'mai_notice' && body.template.language.code === 'ru');
r = channelRequest(normalizeChannel({ type: 'rocketchat', url: 'https://chat.example/hooks/abc' }), ev);
check('Rocket.Chat: входящий webhook с text и alias', r.url === 'https://chat.example/hooks/abc' && JSON.parse(r.init.body).text === text && JSON.parse(r.init.body).alias === 'MAI Code');
check('webhook: text и content (Slack/Discord)', webhookPayload(ev).text === text && webhookPayload(ev).content === text);

console.log('[3] доставка');
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
  on(e, fn) {
    this.handlers[e] = fn;
  }
  show() {
    shown.push(this);
  }
}
const posts = [];
let focused = true;
const logs = [];
let settings = {
  notifications: {
    channels: [
      { id: 'tg', type: 'telegram', token: 'T', chatId: '1', kinds: ['done', 'approval'] },
      { id: 'mx', type: 'max', token: 'M', chatId: '2', kinds: ['done'] },
      { id: 'rc', type: 'rocketchat', url: 'https://rc.example/hooks/x', kinds: ['error'] },
    ],
  },
};
const json = (status, data) => ({ ok: status < 300, status, clone: () => ({ json: async () => data }) });
const notify = createNotifier({
  Notification: FakeNotification,
  getSettings: () => settings,
  isFocused: () => focused,
  onClick: (x) => clicks.push(x),
  fetch: async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    if (url.includes('telegram')) return json(200, { ok: true });
    if (url.includes('max.ru')) return json(200, { success: false, message: 'chat not found' });
    return json(500, {});
  },
  log: (t) => logs.push(t),
});
let res = await notify('done', { title: 'Готово: отчёт', body: 'сводка', sessionId: 's1' });
check('в фокусе — без рабочего стола; в каналы по их событиям', !res.desktop && posts.length === 2 && res.channels.tg === true && res.channels.mx === false && !('rc' in res.channels), JSON.stringify(res));
check('MAX ответил 200 с success:false — не доставлено, в журнал', logs.some((t) => /MAX/.test(t)));
focused = false;
res = await notify('approval', { title: 'Нужно подтверждение', sessionId: 's1' });
check('вне фокуса — рабочий стол; approval — только в Telegram', res.desktop && posts.length === 3 && posts.at(-1).url.includes('telegram'));
shown.at(-1).handlers.click();
check('клик — открыть чат', clicks.at(-1)?.sessionId === 's1');
res = await notify('approval', { title: 'Нужно подтверждение', sessionId: 's1' });
check('то же за 10 с — не повторяется', res.deduped === true);
res = await notify('done', { title: 'Проверка' }, { channelId: 'rc', force: true });
check('проверка одного канала: только он, без рабочего стола', !res.desktop && res.channels.rc === false && Object.keys(res.channels).join() === 'rc' && logs.some((t) => /Rocket\.Chat: HTTP 500/.test(t)));

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
