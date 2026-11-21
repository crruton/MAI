/**
 * Схемы данных IPC (Q7, ADR 0060).
 */
import fs from 'node:fs';
import { validateIpc, checkShape, IPC_SCHEMAS } from '../electron/lib/ipc-schemas.js';
import { IPC_PERMISSIONS } from '../electron/lib/ipc-permissions.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}
console.log('[1] типы');
check('верный вызов', validateIpc('trust:set', [{ projectDir: 'C:/p', state: 'trusted' }]) === null);
check('нет обязательного поля', /state: обязательное поле/.test(validateIpc('trust:set', [{ projectDir: 'C:/p' }])));
check('строка вместо объекта', /ожидался объект/.test(validateIpc('trust:set', ['C:/p'])));
check('необязательное — null допустим', validateIpc('session:addDir', [null]) === null && validateIpc('mcp:connect', ['srv']) === null);
check('число: NaN не число', /ожидался number/.test(validateIpc('checkpoints:plan', [{ sessionId: 's', turn: Number.NaN }])));
check('булево вместо строки', /ожидался boolean/.test(validateIpc('packages:toggle', [{ name: 'x', enabled: 'да' }])));
check('массив вместо объекта настроек', /ожидался object, пришло array/.test(validateIpc('settings:save', [[1, 2]])));
check('лишние поля допустимы', validateIpc('chat:approval', [{ id: 'a', allow: true, extraThing: 1 }]) === null);
check('канал без схемы — только общая проверка', validateIpc('docs:list', []) === null);
console.log('[2] общая проверка');
check('__proto__, constructor, prototype', ['__proto__', 'constructor', 'prototype'].every((k) => /недопустимый ключ/.test(checkShape([JSON.parse(`{"a":{"${k}":1}}`)]))));
let deep = {};
const root = deep;
for (let i = 0; i < 20; i += 1) deep = deep.x = {};
check('глубина', /вложенность/.test(checkShape([root])));
check('длинный массив', /массив длиннее/.test(checkShape([new Array(60_000).fill(0)])));
check('длинная строка', /строка длиннее/.test(checkShape(['x'.repeat(10 * 1024 * 1024 + 1)])));
const cyc = {};
cyc.self = cyc;
check('цикл', /циклическая/.test(checkShape([cyc])));
console.log('[3] покрытие');
check('схемы только для известных каналов', Object.keys(IPC_SCHEMAS).every((c) => Object.hasOwn(IPC_PERMISSIONS, c)), Object.keys(IPC_SCHEMAS).filter((c) => !Object.hasOwn(IPC_PERMISSIONS, c)).join());
const admin = Object.entries(IPC_PERMISSIONS).filter(([, p]) => p !== 'any').map(([c]) => c);
const typed = admin.filter((c) => IPC_SCHEMAS[c]);
console.log(`  —    каналы admin/self со схемой: ${typed.length} из ${admin.length}`);
// Каждый вызов из preload с объектом совпадает по полям со схемой — грубая сверка имён полей.
const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const mismatches = [];
for (const m of preload.matchAll(/invoke\('([^']+)', \{ ([^}]+) \}\)/g)) {
  const schema = IPC_SCHEMAS[m[1]]?.[0];
  if (!schema || typeof schema !== 'object') continue;
  const fields = m[2].split(',').map((f) => f.trim().split(':')[0].replace('...', '')).filter(Boolean);
  for (const [key, type] of Object.entries(schema)) if (!type.endsWith('?') && type !== 'any' && !fields.includes(key)) mismatches.push(`${m[1]}.${key}`);
}
check('обязательные поля схем есть в вызовах preload', mismatches.length === 0, mismatches.join(', '));
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
