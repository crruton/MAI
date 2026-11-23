/**
 * Шифрование секретов в settings.json (бэклог CC13.7, ADR 0031).
 *
 * Ключи провайдеров, токен Vault и токен MAS хранятся как `enc:v1:<base64>`,
 * зашифрованные хранилищем ОС (Electron safeStorage: DPAPI на Windows,
 * Keychain на macOS, libsecret/kwallet на Linux). Плагин или другой процесс,
 * прочитавший файл, ключ не получит.
 *
 * Модуль не зависит от Electron: шифр передаётся явно, это позволяет
 * проверять его обычным node.
 */

export const SEALED_PREFIX = 'enc:v1:';

/** Пути секретов в настройках. `*` — любой ключ объекта. */
export const SECRET_PATHS = [
  ['providers', '*', 'apiKey'],
  ['infra', 'vaultToken'],
  ['mas', 'token'],
  // Токены MCP-серверов: заголовки (Authorization) и переменные окружения (ADR 0052).
  ['mcpServers', '*', 'headers', '*'],
  ['mcpServers', '*', 'env', '*'],
  ['webSearch', 'apiKey'],
  // Webhook уведомлений (CW5.4): адрес Slack/Discord — по сути токен канала.
  ['notifications', 'webhookUrl'],
  // Каналы уведомлений (CW5.4): токены ботов и адреса webhook.
  ['notifications', 'channels', '*', 'token'],
  ['notifications', 'channels', '*', 'url'],
];

export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}

/**
 * @param {object} cipher { available(): boolean, weak?(): boolean, encrypt(text): Buffer, decrypt(Buffer): string }
 */
export function createSecretBox(cipher) {
  const available = () => {
    try {
      return Boolean(cipher?.available?.());
    } catch {
      return false;
    }
  };
  return {
    available,
    /** 'os' — хранилище ОС, 'weak' — шифр без ключа ОС (Linux basic_text), 'none' — открытый текст. */
    protection() {
      if (!available()) return 'none';
      try {
        return cipher.weak?.() ? 'weak' : 'os';
      } catch {
        return 'os';
      }
    },
    seal(value) {
      const text = String(value ?? '');
      if (!text || isSealed(text) || text === '***' || !available()) return text;
      return `${SEALED_PREFIX}${Buffer.from(cipher.encrypt(text)).toString('base64')}`;
    },
    /** Расшифровка. null — значение зашифровано, но прочитать его нельзя. */
    open(value) {
      if (!isSealed(value)) return value ?? '';
      try {
        return cipher.decrypt(Buffer.from(value.slice(SEALED_PREFIX.length), 'base64'));
      } catch {
        return null;
      }
    },
  };
}

function walk(obj, pathParts, fn, at = []) {
  if (!obj || typeof obj !== 'object') return;
  const [head, ...rest] = pathParts;
  const keys = head === '*' ? Object.keys(obj) : [head];
  for (const key of keys) {
    if (!Object.hasOwn(obj, key)) continue;
    if (!rest.length) fn(obj, key, [...at, key]);
    else walk(obj[key], rest, fn, [...at, key]);
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Копия настроек с зашифрованными секретами — для записи на диск. */
export function sealSettings(settings, box) {
  const out = clone(settings) || {};
  for (const parts of SECRET_PATHS) {
    walk(out, parts, (parent, key) => {
      parent[key] = box.seal(parent[key]);
    });
  }
  return out;
}

/**
 * Копия настроек с расшифрованными секретами — для работы в памяти main.
 * Возвращает также список путей, которые расшифровать не удалось.
 */
export function openSettings(settings, box) {
  const out = clone(settings) || {};
  const unreadable = [];
  for (const parts of SECRET_PATHS) {
    walk(out, parts, (parent, key, at) => {
      const opened = box.open(parent[key]);
      if (opened === null) {
        unreadable.push(at.join('.'));
        parent[key] = '';
      } else {
        parent[key] = opened;
      }
    });
  }
  return { settings: out, unreadable };
}

/**
 * Перед записью: если секрет не удалось расшифровать при чтении, а новое
 * значение пустое, оставляем зашифрованное значение с диска — иначе ключ
 * пропал бы из-за временной недоступности хранилища ОС.
 */
export function keepUnreadable(sealed, rawOnDisk, unreadable) {
  for (const dotted of unreadable || []) {
    const parts = dotted.split('.');
    let target = sealed;
    let source = rawOnDisk;
    for (const part of parts.slice(0, -1)) {
      target = target?.[part];
      source = source?.[part];
    }
    const key = parts.at(-1);
    if (target && source && !target[key] && isSealed(source[key])) target[key] = source[key];
  }
  return sealed;
}

/** Пути секретов, которые лежат открытым текстом. */
export function plaintextSecrets(settings) {
  const found = [];
  for (const parts of SECRET_PATHS) {
    walk(settings, parts, (parent, key, at) => {
      const value = parent[key];
      if (typeof value === 'string' && value && value !== '***' && !isSealed(value)) found.push(at.join('.'));
    });
  }
  return found;
}
