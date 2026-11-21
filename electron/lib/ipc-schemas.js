/**
 * Проверка данных IPC (бэклог Q7, ADR 0060).
 *
 * 1) Общая проверка для любого канала: глубина ≤ 12, строка ≤ 10 МБ, массив ≤
 *    50 000 элементов, всего ≤ 50 МБ, ключи `__proto__`, `constructor`,
 *    `prototype` запрещены (засорение прототипа в обработчиках с `{...payload}`).
 * 2) Типы аргументов для каналов, которые меняют права, файлы, настройки или
 *    запускают код. Тип: 'string' | 'number' | 'boolean' | 'object' | 'array' |
 *    'any', с «?» — необязательный (null/undefined). Объект — { поле: тип };
 *    лишние поля допускаются (у некоторых каналов расширяемые данные).
 *
 * Модуль не зависит от Electron.
 */
const MAX_DEPTH = 12;
const MAX_STRING = 10 * 1024 * 1024;
const MAX_ARRAY = 50_000;
const MAX_TOTAL = 50 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const S = 'string';
const S_ = 'string?';
const N = 'number';
const N_ = 'number?';
const B = 'boolean';
const B_ = 'boolean?';
const O = 'object';
const O_ = 'object?';
const A_ = 'array?';
const ANY = 'any';

export const IPC_SCHEMAS = {
  'trust:set': [{ projectDir: S, state: S }],
  'trust:remove': [S],
  'trust:get': [S_],
  'permissions:set': [{ mode: S, sessionId: S_ }],
  'permissions:rules': [{ sessionId: S_, scope: S_, kind: S_, add: A_, remove: A_ }],
  'permissions:explain': [{ sessionId: S_, tool: S_, subject: S_ }],
  'permissions:audit': [{ limit: N_ }],
  'permissions:modes': [S_],
  'chat:start': [{ sessionId: S_, text: S_, displayText: S_, model: S_, projectDir: S_, permissionMode: S_, kind: S_, effort: S_, images: A_ }],
  'chat:approval': [{ id: S, allow: B_, remember: S_, rules: A_, feedback: S_, message: S_ }],
  'chat:answer': [{ id: S, answer: ANY }],
  'chat:queue': [{ text: S, displayText: S_ }],
  'chat:unqueue': [{ id: S }],
  'chat:compact': [{ sessionId: S, instructions: S_ }],
  'checkpoints:plan': [{ sessionId: S, turn: N }],
  'checkpoints:rewind': [{ sessionId: S, turn: N, mode: S_ }],
  'checkpoints:turns': [S_],
  'commands:expand': [{ projectDir: S_, name: S, args: S_ }],
  'commands:list': [S_],
  'files:search': [{ projectDir: S_, query: S_ }],
  'packages:install': [{ from: S, replace: B_ }],
  'packages:uninstall': [S],
  'packages:toggle': [{ name: S, enabled: B }],
  'marketplace:add': [{ url: S, name: S_ }],
  'marketplace:install': [{ marketplace: S, name: S, replace: B_ }],
  'marketplace:remove': [S],
  'mcp:connect': [S, S_],
  'mcp:login': [S, S_],
  'mcp:logout': [S],
  'mcp:remove': [S, S_],
  'mcp:saveLocal': [{ projectDir: S_, name: S, config: O_ }],
  'connectors:add': [{ id: S, token: S_ }],
  'connectors:remove': [S],
  'session:addDir': [S_],
  'session:removeDir': [{ sessionId: S, dir: S }],
  'session:setKind': [{ sessionId: S_, kind: S }],
  'session:dirs': [S_],
  'session:kind': [S_],
  'schedule:save': [{ id: S_, title: S_, prompt: S_, schedule: O_, kind: S_, projectDir: S_, model: S_, enabled: B_ }],
  'schedule:remove': [S],
  'schedule:runNow': [S],
  'schedule:runs': [S_],
  'trash:restore': [{ id: S, overwrite: B_ }],
  'trash:purge': [{ id: S_, all: B_ }],
  'results:list': [S_],
  'results:open': [{ sessionId: S, file: S }],
  'results:show': [{ sessionId: S, file: S }],
  'results:preview': [{ sessionId: S, file: S }],
  'app:openExternal': [S],
  'app:openPath': [S],
  'app:showItem': [S],
  'app:clipboard': [S],
  'settings:save': [O],
  'skills:create': [O],
  'skills:delete': [S],
  'agents:write': [{ file: S, content: S }],
  'memory:write': [{ file: S, content: S, projectDir: S_ }],
  'sessions:get': [S],
  'sessions:delete': [S],
  'auth:setRole': [S],
  'models:caps': [S_],
  // Остальные каналы admin/self: данные — объект или строка, как их передаёт preload.
  'auth:configure': [O_],
  'providers:save': [{ id: S, provider: O }],
  'providers:remove': [S],
  'runtimes:save': [ANY],
  'runtimes:run': [O_],
  'runtimes:runMany': [O_],
  'workspace:create': [O_],
  'memory:save': [O_],
  'memory:append': [O_],
  'memory:restore': [O_],
  'multica:syncDocs': [S_],
  'sandbox:start': [O_],
  'sandbox:stop': [O_],
  'sandbox:exec': [O_],
  'mcp:sync': [S_],
  'plugins:createExample': [S_],
  'artifacts:save': [O_],
  'artifacts:restore': [O_],
  'artifacts:delete': [O_],
  'artifacts:import': [O_],
  'artifacts:applyToFile': [O_],
  'boards:save': [O_],
  'boards:baseline': [O_],
  'boards:stageRun': [O_],
  'boards:correction': [O_],
  'boards:diagramChat': [O_],
  'boards:saveView': [O_],
  'infra:sync': [O_],
  'infra:upload': [O_],
  'infra:download': [O_],
  'repowise:init': [O_],
  'repowise:update': [O_],
  'repowise:distill': [O_],
  'repowise:connectMcp': [O_],
  'repowise:serve': [O_],
  'repowise:stopServe': [O_],
};

function typeOf(value) {
  if (value === null || value === undefined) return 'nil';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'nan';
  return typeof value;
}

function checkType(spec, value, where) {
  if (typeof spec === 'object' && spec) {
    if (typeOf(value) !== 'object') return `${where}: ожидался объект, пришло ${typeOf(value)}`;
    for (const [key, sub] of Object.entries(spec)) {
      const err = checkType(sub, value[key], `${where}.${key}`);
      if (err) return err;
    }
    return null;
  }
  const optional = spec.endsWith('?');
  const want = optional ? spec.slice(0, -1) : spec;
  const got = typeOf(value);
  if (got === 'nil') return optional || want === ANY ? null : `${where}: обязательное поле`;
  if (want === ANY || got === want) return null;
  return `${where}: ожидался ${want}, пришло ${got}`;
}

/** Общая проверка структуры. Возвращает текст ошибки или null. */
export function checkShape(args) {
  let total = 0;
  const seen = new Set();
  const walk = (value, depth, where) => {
    if (depth > MAX_DEPTH) return `${where}: вложенность больше ${MAX_DEPTH}`;
    if (typeof value === 'string') {
      total += value.length;
      if (value.length > MAX_STRING) return `${where}: строка длиннее ${MAX_STRING} символов`;
    } else if (value && typeof value === 'object') {
      if (seen.has(value)) return `${where}: циклическая ссылка`;
      seen.add(value);
      if (Array.isArray(value)) {
        if (value.length > MAX_ARRAY) return `${where}: массив длиннее ${MAX_ARRAY}`;
        for (let i = 0; i < value.length; i += 1) {
          const err = walk(value[i], depth + 1, `${where}[${i}]`);
          if (err) return err;
        }
      } else {
        for (const key of Object.keys(value)) {
          if (FORBIDDEN_KEYS.has(key)) return `${where}: недопустимый ключ ${key}`;
          total += key.length;
          const err = walk(value[key], depth + 1, `${where}.${key}`);
          if (err) return err;
        }
      }
    }
    if (total > MAX_TOTAL) return 'данные больше 50 МБ';
    return null;
  };
  for (let i = 0; i < args.length; i += 1) {
    const err = walk(args[i], 0, `аргумент ${i + 1}`);
    if (err) return err;
  }
  return null;
}

/** Полная проверка вызова канала: структура + типы, если для канала есть схема. */
export function validateIpc(channel, args) {
  const shape = checkShape(args);
  if (shape) return shape;
  const schema = IPC_SCHEMAS[channel];
  if (!schema) return null;
  for (let i = 0; i < schema.length; i += 1) {
    const err = checkType(schema[i], args[i], `аргумент ${i + 1}`);
    if (err) return err;
  }
  return null;
}
