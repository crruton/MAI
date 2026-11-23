/**
 * Уведомления (CW5.4, ADR 0081): на рабочем столе, когда окно не в фокусе, и
 * по желанию — в мессенджер через входящий webhook (Slack, Mattermost,
 * Discord, Teams и совместимые). Один вход для всех событий: агент закончил,
 * ждёт подтверждения, задал вопрос, ошибка, фоновый субагент, плановая задача.
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

const DEFAULTS = {
  desktop: Object.keys(NOTIFY_KINDS),
  webhook: ['done', 'error', 'scheduled'],
};

/** Что включено: { desktop: [виды], webhook: [виды], webhookUrl }. */
export function notifySettings(settings = {}) {
  const raw = settings.notifications || {};
  const list = (value, fallback) => (Array.isArray(value) ? value.filter((k) => k in NOTIFY_KINDS) : fallback);
  const url = String(raw.webhookUrl || '').trim();
  return {
    desktop: raw.enabled === false ? [] : list(raw.desktop, DEFAULTS.desktop),
    webhook: /^https:\/\//.test(url) ? list(raw.webhook, DEFAULTS.webhook) : [],
    webhookUrl: /^https:\/\//.test(url) ? url : '',
  };
}

/** Тело для webhook: `text` (Slack, Mattermost, Teams), `content` (Discord). Без содержимого файлов — только суть. */
export function webhookPayload({ kind, title, body }) {
  const line = `${title}${body ? ` — ${body}` : ''}`.slice(0, 1500);
  return { text: `MAI Code · ${NOTIFY_KINDS[kind] || kind}: ${line}`, content: `MAI Code · ${NOTIFY_KINDS[kind] || kind}: ${line}` };
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
  return async function notify(kind, { title, body = '', sessionId = '' } = {}) {
    const cfg = notifySettings(getSettings());
    const key = `${kind}|${title}|${sessionId}`;
    const now = Date.now();
    if (now - (recent.get(key) || 0) < 10_000) return { desktop: false, webhook: false, deduped: true };
    recent.set(key, now);
    const result = { desktop: false, webhook: false };
    if (cfg.desktop.includes(kind) && !isFocused()) {
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
    if (cfg.webhook.includes(kind) && doFetch) {
      try {
        const res = await doFetch(cfg.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookPayload({ kind, title, body })),
          signal: AbortSignal.timeout(10_000),
        });
        result.webhook = res.ok;
        if (!res.ok) log(`webhook уведомлений: HTTP ${res.status}`);
      } catch (err) {
        log(`webhook уведомлений: ${err?.message || err}`);
      }
    }
    return result;
  };
}
