/**
 * Уведомления (CW5.4, ADR 0081): на рабочем столе, когда окно не в фокусе, и
 * в мессенджеры — каналами. Один вход для всех событий: агент закончил, ждёт
 * подтверждения, задал вопрос, ошибка, фоновый субагент, плановая задача.
 *
 * Каналы (`settings.notifications.channels`, у каждого свои события):
 *   telegram   — бот: токен и chat_id (Bot API sendMessage);
 *   max        — бот мессенджера MAX: токен и chat_id или user_id (POST /messages);
 *   whatsapp   — WhatsApp Cloud API: токен, phone_number_id, номер получателя;
 *                вне 24-часового окна — только шаблон (template);
 *   rocketchat — входящий webhook Rocket.Chat;
 *   webhook    — входящий webhook Slack, Mattermost, Discord, Teams.
 * В мессенджер уходит только заголовок и суть, без файлов.
 * Модуль не зависит от Electron: `Notification` и `fetch` передаются снаружи.
 */

export const NOTIFY_KINDS = {
  done: 'агент закончил',
  approval: 'нужно подтверждение',
  question: 'агент спрашивает',
  error: 'ошибка прогона',
  background: 'фоновый субагент',
  scheduled: 'плановая задача',
};

export const CHANNEL_TYPES = {
  telegram: 'Telegram',
  max: 'MAX',
  whatsapp: 'WhatsApp',
  rocketchat: 'Rocket.Chat',
  webhook: 'Webhook (Slack, Mattermost, Discord, Teams)',
};

const DEFAULT_KINDS = ['done', 'error', 'scheduled'];
const MAX_HOST = 'https://platform-api2.max.ru';
const WHATSAPP_API = 'https://graph.facebook.com/v21.0';

const str = (v) => String(v ?? '').trim();
const https = (v) => /^https:\/\/[^\s]+$/.test(str(v));

/** Канал из настроек → нормальный вид или null (тип неизвестен, нет обязательных полей). */
export function normalizeChannel(raw = {}, index = 0) {
  const type = str(raw.type);
  if (!CHANNEL_TYPES[type]) return null;
  const kinds = Array.isArray(raw.kinds) ? raw.kinds.filter((k) => k in NOTIFY_KINDS) : DEFAULT_KINDS;
  const base = { id: str(raw.id) || `ch${index + 1}`, type, name: str(raw.name) || CHANNEL_TYPES[type], enabled: raw.enabled !== false, kinds };
  switch (type) {
    case 'telegram':
      return str(raw.token) && str(raw.chatId) ? { ...base, token: str(raw.token), chatId: str(raw.chatId) } : null;
    case 'max':
      return str(raw.token) && str(raw.chatId) ? { ...base, token: str(raw.token), chatId: str(raw.chatId), target: raw.target === 'user' ? 'user' : 'chat', apiBase: https(raw.apiBase) ? str(raw.apiBase).replace(/\/$/, '') : MAX_HOST } : null;
    case 'whatsapp':
      return str(raw.token) && /^\d+$/.test(str(raw.phoneNumberId)) && /^\+?\d{7,15}$/.test(str(raw.to))
        ? { ...base, token: str(raw.token), phoneNumberId: str(raw.phoneNumberId), to: str(raw.to).replace(/^\+/, ''), template: str(raw.template), lang: str(raw.lang) || 'ru' }
        : null;
    default:
      // webhook и rocketchat — адрес входящего webhook.
      return https(raw.url) ? { ...base, url: str(raw.url) } : null;
  }
}

/**
 * Что включено: { desktop: [виды], channels: [канал] }. Старая настройка
 * `webhookUrl` + `webhook` превращается в канал webhook.
 */
export function notifySettings(settings = {}) {
  const raw = settings.notifications || {};
  const list = (value, fallback) => (Array.isArray(value) ? value.filter((k) => k in NOTIFY_KINDS) : fallback);
  const sources = Array.isArray(raw.channels) ? [...raw.channels] : [];
  if (https(raw.webhookUrl) && !sources.some((c) => c?.type === 'webhook' && str(c.url) === str(raw.webhookUrl))) {
    sources.push({ id: 'legacy', type: 'webhook', url: raw.webhookUrl, kinds: list(raw.webhook, DEFAULT_KINDS) });
  }
  return {
    desktop: raw.enabled === false ? [] : list(raw.desktop, Object.keys(NOTIFY_KINDS)),
    channels: sources.map(normalizeChannel).filter((c) => c && c.enabled),
  };
}

/** Текст сообщения: вид события, заголовок, суть. */
export function messageText({ kind, title, body }) {
  return `MAI Code · ${NOTIFY_KINDS[kind] || kind}: ${title}${body ? ` — ${body}` : ''}`.slice(0, 1500);
}

/** Тело для webhook: `text` (Slack, Mattermost, Teams), `content` (Discord). */
export function webhookPayload(event) {
  const text = messageText(event);
  return { text, content: text };
}

/** Запрос в канал: { url, init } для fetch. */
export function channelRequest(channel, event) {
  const text = messageText(event);
  const json = (url, body, headers = {}) => ({ url, init: { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) } });
  switch (channel.type) {
    case 'telegram':
      return json(`https://api.telegram.org/bot${encodeURIComponent(channel.token)}/sendMessage`, { chat_id: channel.chatId, text, disable_web_page_preview: true });
    case 'max':
      // Токен — в заголовке Authorization (без Bearer), адресат — chat_id или user_id в адресе.
      return json(`${channel.apiBase}/messages?${channel.target === 'user' ? 'user_id' : 'chat_id'}=${encodeURIComponent(channel.chatId)}`, { text }, { Authorization: channel.token });
    case 'whatsapp':
      return json(
        `${WHATSAPP_API}/${channel.phoneNumberId}/messages`,
        channel.template
          ? { messaging_product: 'whatsapp', to: channel.to, type: 'template', template: { name: channel.template, language: { code: channel.lang } } }
          : { messaging_product: 'whatsapp', to: channel.to, type: 'text', text: { body: text, preview_url: false } },
        { Authorization: `Bearer ${channel.token}` },
      );
    case 'rocketchat':
      return json(channel.url, { text, alias: 'MAI Code' });
    default:
      return json(channel.url, webhookPayload(event));
  }
}

/** Ответ канала — успех? Telegram и MAX отвечают 200 и с ошибкой в теле. */
async function delivered(res) {
  if (!res?.ok) return false;
  try {
    const data = await res.clone?.().json?.();
    if (data && data.ok === false) return false;
    if (data && data.success === false) return false;
  } catch {
    /* не JSON — достаточно статуса */
  }
  return true;
}

/**
 * @param {object} deps
 * @param {Function} deps.Notification класс Electron (или подделка)
 * @param {Function} deps.getSettings () → настройки
 * @param {Function} deps.isFocused () → true, если окно приложения в фокусе
 * @param {Function} [deps.onClick] (payload) → открыть чат
 * @param {Function} [deps.fetch]
 * @param {Function} [deps.log] (text) → журнал ошибок доставки
 */
export function createNotifier({ Notification, getSettings, isFocused = () => false, onClick = null, fetch: doFetch = globalThis.fetch, log = () => {} }) {
  const recent = new Map(); // ключ → время: одно и то же не повторяем чаще раза в 10 с
  return async function notify(kind, { title, body = '', sessionId = '' } = {}, { channelId = '', force = false } = {}) {
    const cfg = notifySettings(getSettings());
    const key = `${kind}|${title}|${sessionId}`;
    const now = Date.now();
    if (!force && now - (recent.get(key) || 0) < 10_000) return { desktop: false, channels: {}, deduped: true };
    recent.set(key, now);
    const result = { desktop: false, channels: {} };
    if (!channelId && cfg.desktop.includes(kind) && !isFocused()) {
      try {
        if (!Notification?.isSupported || Notification.isSupported()) {
          const n = new Notification({ title: String(title).slice(0, 120), body: String(body).replace(/\s+/g, ' ').slice(0, 240) });
          if (onClick) n.on?.('click', () => onClick({ kind, sessionId }));
          n.show();
          result.desktop = true;
        }
      } catch (err) {
        log(`уведомление: ${err?.message || err}`);
      }
    }
    const targets = cfg.channels.filter((c) => (channelId ? c.id === channelId : c.kinds.includes(kind)));
    await Promise.all(
      targets.map(async (channel) => {
        if (!doFetch) return;
        try {
          const { url, init } = channelRequest(channel, { kind, title, body });
          const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
          const ok = await delivered(res);
          result.channels[channel.id] = ok;
          if (!ok) log(`уведомление в ${channel.name}: HTTP ${res?.status}`);
        } catch (err) {
          result.channels[channel.id] = false;
          log(`уведомление в ${channel.name}: ${err?.message || err}`);
        }
      }),
    );
    // Для совместимости со старым видом ответа.
    result.webhook = Object.values(result.channels).some(Boolean);
    return result;
  };
}
