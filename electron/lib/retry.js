/**
 * Повторы и запасная модель (бэклог CC13.2, CC13.3, ADR 0057).
 * Модуль не зависит от Electron.
 */
export const RETRY_DELAYS = [2000, 5000, 12000];
const MAX_DELAY = 30_000;

function statusOf(err) {
  return Number(err?.status ?? err?.response?.status ?? err?.statusCode) || 0;
}

/** Временный сбой: перегрузка, лимит, 5xx, обрыв соединения. */
export function isTransient(err) {
  if (!err || err.name === 'AbortError') return false;
  const status = statusOf(err);
  if ([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529].includes(status)) return true;
  if (status) return false;
  const text = `${err.code || ''} ${err.message || ''} ${err.cause?.code || ''} ${err.cause?.message || ''}`;
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR|socket hang up|fetch failed|terminated|network|Connection error|overloaded/i.test(text);
}

/** Сбой, при котором поможет другая модель: исчерпаны повторы, модель не найдена, нет доступа, контекст. */
export function needsFallback(err) {
  const status = statusOf(err);
  if (isTransient(err)) return true;
  if ([401, 402, 403, 404].includes(status)) return true;
  return /model_not_found|does not exist|no such model|insufficient_quota|context_length_exceeded|maximum context/i.test(String(err?.message || ''));
}

/** Пауза перед повтором: Retry-After из ответа (до 30 с) или по таблице. */
export function retryDelay(err, attempt) {
  const header = err?.headers?.get?.('retry-after') ?? err?.headers?.['retry-after'] ?? err?.response?.headers?.get?.('retry-after');
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_DELAY);
  return RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
}

/** Короткое описание ошибки для уведомления. */
export function describeError(err) {
  const status = statusOf(err);
  const text = String(err?.message || err || '').replace(/\s+/g, ' ').slice(0, 160);
  return status ? `${status}: ${text}` : text;
}

/** Ожидание, которое прерывает «Стоп». */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Остановлено'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Остановлено'));
    }, { once: true });
  });
}
