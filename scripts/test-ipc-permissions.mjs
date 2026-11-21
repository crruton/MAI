/**
 * Матрица прав IPC (ADR 0028, бэклог Q2).
 *
 * Падает, если канал `ipcMain.handle` не внесён в матрицу, если в матрице
 * остался несуществующий канал или если preload зовёт канал, которого нет.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_PERMISSIONS, guardIpc, permissionOf } from '../electron/lib/ipc-permissions.js';

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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');

const handled = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));
const invoked = new Set([...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]));
const matrix = new Set(Object.keys(IPC_PERMISSIONS));

console.log('\n[1] Полнота матрицы');
const missing = [...handled].filter((c) => !matrix.has(c));
check(`все ${handled.size} каналов main.js в матрице`, missing.length === 0, missing.join(', '));
const stale = [...matrix].filter((c) => !handled.has(c));
check('в матрице нет несуществующих каналов', stale.length === 0, stale.join(', '));
const orphan = [...invoked].filter((c) => !handled.has(c));
check('каждый канал preload обработан в main', orphan.length === 0, orphan.join(', '));
check('значения только any / admin / self', Object.values(IPC_PERMISSIONS).every((v) => ['any', 'admin', 'self'].includes(v)));

console.log('\n[2] Опасные каналы закрыты');
for (const channel of [
  'runtimes:run',
  'runtimes:runMany',
  'mcp:connect',
  'mcp:remove',
  'mcp:sync',
  'plugins:createExample',
  'infra:pushSecrets',
  'infra:pullSecrets',
  'repowise:install',
  'repowise:distill',
  'repowise:serve',
  'sandbox:exec',
  'settings:save',
  'providers:save',
  'trust:remove',
  'permissions:audit',
]) {
  check(`${channel} — admin`, IPC_PERMISSIONS[channel] === 'admin', IPC_PERMISSIONS[channel]);
}
check('trust:set проверяет роль сам', IPC_PERMISSIONS['trust:set'] === 'self');
check('permissions:set проверяет роль сам', IPC_PERMISSIONS['permissions:set'] === 'self');
check('чат доступен всем', IPC_PERMISSIONS['chat:start'] === 'any');
check('неизвестный канал → admin', permissionOf('nope:x') === 'admin');

console.log('\n[3] Обработчики self действительно проверяют роль');
const body = (channel) => {
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  const next = main.indexOf('ipcMain.handle(', start + 10);
  return main.slice(start, next === -1 ? undefined : next);
};
for (const [channel, value] of Object.entries(IPC_PERMISSIONS)) {
  if (value !== 'self') continue;
  check(`${channel}: в обработчике есть проверка роли`, /requireAdmin\(\)|authStatus\(\)\.role/.test(body(channel)));
}

console.log('\n[4] Обёртка guardIpc');
const handlers = new Map();
const fakeIpc = { handle: (channel, fn) => handlers.set(channel, fn) };
let role = 'guest';
const unknown = [];
guardIpc(fakeIpc, () => {
  if (role !== 'admin') throw new Error('Недостаточно прав: требуется роль admin');
}, { onUnknown: (c) => unknown.push(c) });
fakeIpc.handle('runtimes:run', () => ({ ok: true, ran: true }));
fakeIpc.handle('chat:start', () => ({ ok: true }));
fakeIpc.handle('secret:new', () => ({ ok: true, ran: true }));
const denied = await handlers.get('runtimes:run')({});
check('гостю admin-канал отказан без исключения', denied.ok === false && denied.forbidden === true, JSON.stringify(denied));
check('обработчик не вызван', !denied.ran);
check('гостю any-канал доступен', (await handlers.get('chat:start')({}, { text: 'привет' })).ok === true);
const bad = await handlers.get('chat:start')({}, { text: 42 });
check('неверный тип поля — отказ до обработчика', bad.ok === false && bad.invalid === true && /text: ожидался string, пришло number/.test(bad.error), JSON.stringify(bad));
const polluted = await handlers.get('chat:start')({}, JSON.parse('{"text":"x","__proto__":{"admin":true}}'));
check('__proto__ в данных — отказ', polluted.invalid === true && /__proto__/.test(polluted.error), JSON.stringify(polluted));
const newDenied = await handlers.get('secret:new')({});
check('канал вне матрицы закрыт для гостя', newDenied.forbidden === true);
check('о канале вне матрицы сообщено', unknown.includes('secret:new'));
role = 'admin';
check('admin проходит', (await handlers.get('runtimes:run')({})).ran === true);

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
