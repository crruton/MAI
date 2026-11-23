import crypto from 'node:crypto';

/**
 * Фильтр секретов в запросах к модели (N3, ADR 0099) — по мотивам GuardrailsEngine
 * OpenJarvis. Ключи, токены, пароли и номера карт в тексте, который уходит модели
 * (системный промпт, сообщения, результаты инструментов), заменяются на
 * `[СКРЫТО:тип:хеш]`. Хеш — от значения: одно и то же значение — один и тот же
 * знак во всех запросах. История на диске не меняется.
 *
 * Если модель вернёт знак в аргументах инструмента (правит .env, пишет конфиг),
 * `unmask` перед выполнением подставит исходное значение — файл не испортится,
 * а модель секрет так и не увидит.
 *
 * Режимы: mask (по умолчанию, решение гриллинга), warn — отправить как есть и
 * предупредить, block — не отправлять запрос, off.
 *
 * Модуль не зависит от Electron.
 */

export const FILTER_MODES = ['mask', 'warn', 'block', 'off'];

const luhn = (digits) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};

/**
 * Правила: type — подпись в знаке, re — поиск (флаг g), group — какая группа
 * секрет (0 — всё совпадение), check — доп. проверка значения.
 */
export const SECRET_RULES = [
  { type: 'приватный-ключ', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { type: 'ключ-anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: 'ключ-openai', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { type: 'токен-github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { type: 'ключ-aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'ключ-google', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'токен-slack', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { type: 'ключ-stripe', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { type: 'токен-telegram', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/g },
  { type: 'bearer', re: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/gi, group: 1 },
  // Пароль в адресе: scheme://user:ПАРОЛЬ@host.
  { type: 'пароль', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@/gi, group: 1 },
  // Присваивания: password=…, "api_key": "…", SECRET: …, token = '…'.
  {
    type: 'пароль',
    re: /(?:^|[\s"'{,;(])["']?((?:[A-Za-z0-9_]*_)?(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|private[_-]?key|client[_-]?secret))["']?\s*[:=]\s*["']?([^\s"',;}]{6,})/gi,
    group: 2,
    check: (v) => !/^(?:\*+|x+|\.{3,}|<[^>]*>|\$\{?[A-Z_]+\}?|process\.env\.\w+|true|false|null|none|undefined|changeme|example|your[_-].*|\[СКРЫТО:[^\]]+\])$/i.test(v) && !/^\[СКРЫТО:/.test(v),
  },
  { type: 'карта', re: /\b(?:\d[ -]?){12,18}\d\b/g, check: (v) => { const d = v.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d) && !/^(\d)\1+$/.test(d); } },
];

const PLACEHOLDER = /\[СКРЫТО:[^:\]]+:([0-9a-f]{6})\]/g;
const tag = (type, value) => `[СКРЫТО:${type}:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 6)}]`;

/** Найти секреты в тексте: [{ type, value, index }] без пересечений. */
export function findSecrets(text = '') {
  const s = String(text ?? '');
  const hits = [];
  for (const rule of SECRET_RULES) {
    // Флаг d — позиции групп: секрет может быть частью совпадения (пароль в адресе).
    const re = new RegExp(rule.re.source, rule.re.flags.includes('d') ? rule.re.flags : `${rule.re.flags}d`);
    for (const m of s.matchAll(re)) {
      const value = rule.group ? m[rule.group] : m[0];
      // Уже знак [СКРЫТО:…] — не секрет (повторная маска ничего не меняет).
      if (!value || value.includes('[СКРЫТО:') || (rule.check && !rule.check(value))) continue;
      const index = rule.group ? m.indices[rule.group][0] : m.index;
      if (hits.some((h) => index < h.index + h.value.length && h.index < index + value.length)) continue;
      hits.push({ type: rule.type, value, index });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * Фильтр на один прогон: mask(text) → текст со знаками, unmask(text) → обратно,
 * found() → { тип: число разных значений }.
 */
export function createSecretFilter({ mode = 'mask' } = {}) {
  const active = FILTER_MODES.includes(mode) ? mode : 'mask';
  const values = new Map(); // хеш → значение
  const types = new Map(); // значение → тип
  const mask = (text) => {
    if (active === 'off' || typeof text !== 'string' || !text) return text;
    const hits = findSecrets(text);
    if (!hits.length) return text;
    let out = '';
    let pos = 0;
    for (const h of hits) {
      const t = tag(h.type, h.value);
      values.set(t.slice(-7, -1), h.value);
      types.set(h.value, h.type);
      out += text.slice(pos, h.index) + (active === 'mask' ? t : h.value);
      pos = h.index + h.value.length;
    }
    return out + text.slice(pos);
  };
  const unmask = (text) => (typeof text === 'string' && text.includes('[СКРЫТО:') ? text.replace(PLACEHOLDER, (all, hash) => values.get(hash) ?? all) : text);
  const found = () => {
    const out = {};
    for (const t of types.values()) out[t] = (out[t] || 0) + 1;
    return out;
  };
  return { mode: active, mask, unmask, found };
}

/** Применить к сообщениям API (chat.completions): строки, части content, аргументы вызовов. */
export function maskMessages(messages, filter) {
  if (!filter || filter.mode === 'off') return messages;
  return messages.map((m) => {
    const next = { ...m };
    if (typeof m.content === 'string') next.content = filter.mask(m.content);
    else if (Array.isArray(m.content)) next.content = m.content.map((p) => (p?.type === 'text' && typeof p.text === 'string' ? { ...p, text: filter.mask(p.text) } : p));
    if (Array.isArray(m.tool_calls)) next.tool_calls = m.tool_calls.map((c) => (c?.function ? { ...c, function: { ...c.function, arguments: filter.mask(c.function.arguments) } } : c));
    return next;
  });
}

/** Текст уведомления: «Скрыто от модели: ключ-openai ×1, пароль ×2». */
export function filterNotice(found, mode) {
  const parts = Object.entries(found).map(([t, n]) => `${t} ×${n}`);
  if (!parts.length) return '';
  if (mode === 'mask') return `Скрыто от модели: ${parts.join(', ')}. В запросе — знаки [СКРЫТО:…]; при правке файлов значения подставляются обратно.`;
  if (mode === 'warn') return `В запросе к модели есть секреты: ${parts.join(', ')} — отправлены как есть (режим «предупреждать»).`;
  return `Запрос не отправлен: в нём секреты (${parts.join(', ')}). Уберите их или смените режим фильтра в настройках.`;
}
