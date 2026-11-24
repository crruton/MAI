/**
 * Безопасная работа с текстом на границах обрезки (ADR 0107).
 *
 * Причина: `String.prototype.slice` режет по кодовым единицам UTF-16. Если
 * граница попадает внутрь суррогатной пары (эмодзи, редкие иероглифы), в
 * строке остаётся одиночный high surrogate. `JSON.stringify` превращает его в
 * escape `\ud83d` — формально валидный JSON, но шлюзы на protobuf отвечают
 * `400 Invalid JSON payload: no low surrogate in string`. Один такой обрывок в
 * истории ломал все следующие запросы сессии.
 *
 * Модуль не зависит от Electron.
 */

/** Кодовая единица — начало суррогатной пары. */
const isHigh = (code) => code >= 0xd800 && code <= 0xdbff;
/** Кодовая единица — вторая половина пары. */
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Обрезка по границе символа: не разрезает суррогатную пару.
 * `safeSlice('🍀🍀', 1)` → `''`, а не половина эмодзи.
 */
export function safeSlice(text, limit) {
  const value = String(text ?? '');
  const max = Number(limit);
  if (!Number.isFinite(max) || max <= 0) return '';
  if (value.length <= max) return value;
  const cut = Math.floor(max);
  // Граница попала между половинами пары — отступаем на одну единицу.
  if (isHigh(value.charCodeAt(cut - 1)) && isLow(value.charCodeAt(cut))) return value.slice(0, cut - 1);
  return value.slice(0, cut);
}

/** Хвост строки без разрезанной пары — для «конца вывода». */
export function safeTail(text, limit) {
  const value = String(text ?? '');
  const max = Number(limit);
  if (!Number.isFinite(max) || max <= 0) return '';
  if (value.length <= max) return value;
  const start = value.length - Math.floor(max);
  if (isHigh(value.charCodeAt(start - 1)) && isLow(value.charCodeAt(start))) return value.slice(start + 1);
  return value.slice(start);
}

/** Заменить одиночные суррогаты на U+FFFD: строка снова кодируется в UTF-8. */
export function sanitizeText(text) {
  const value = String(text ?? '');
  if (!hasLoneSurrogate(value)) return value;
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (isHigh(code) && i + 1 < value.length && isLow(value.charCodeAt(i + 1))) {
      out += value[i] + value[i + 1];
      i += 1;
      continue;
    }
    out += isHigh(code) || isLow(code) ? '\uFFFD' : value[i];
  }
  return out;
}

/** Есть ли в строке одиночный суррогат. */
export function hasLoneSurrogate(text) {
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (isHigh(code)) {
      if (i + 1 < value.length && isLow(value.charCodeAt(i + 1))) {
        i += 1;
        continue;
      }
      return true;
    }
    if (isLow(code)) return true;
  }
  return false;
}

/**
 * Санитайз сообщений API перед отправкой: content (строка или части),
 * аргументы вызовов инструментов, имя. Возвращает новые объекты, вход не меняет.
 */
export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    const next = { ...message };
    if (typeof next.content === 'string') next.content = sanitizeText(next.content);
    else if (Array.isArray(next.content)) {
      next.content = next.content.map((part) => (part && typeof part.text === 'string' ? { ...part, text: sanitizeText(part.text) } : part));
    }
    if (typeof next.name === 'string') next.name = sanitizeText(next.name);
    if (Array.isArray(next.tool_calls)) {
      next.tool_calls = next.tool_calls.map((call) => {
        if (!call || !call.function) return call;
        const fn = { ...call.function };
        if (typeof fn.arguments === 'string') fn.arguments = sanitizeText(fn.arguments);
        if (typeof fn.name === 'string') fn.name = sanitizeText(fn.name);
        return { ...call, function: fn };
      });
    }
    return next;
  });
}
