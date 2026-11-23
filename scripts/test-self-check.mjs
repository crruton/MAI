/**
 * Самопроверка установленного приложения и системные сертификаты (F25, ADR 0095).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSelfCheck, selfCheckOut, runSelfCheck } from '../electron/lib/self-check.js';
import { applySystemCa } from '../electron/lib/system-ca.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 300)}`);
  }
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

console.log('[1] аргументы');
check('--self-check и --self-check=файл', isSelfCheck(['exe', '--self-check']) && isSelfCheck(['exe', '--self-check=C:\\r.json']) && !isSelfCheck(['exe', '-p', 'x']));
check('файл отчёта: аргумент, затем переменная', selfCheckOut(['exe', '--self-check=a.json'], { MAI_SELF_CHECK_OUT: 'b.json' }) === 'a.json' && selfCheckOut(['exe', '--self-check'], { MAI_SELF_CHECK_OUT: 'b.json' }) === 'b.json' && selfCheckOut(['exe'], {}) === '');

console.log('[2] проверка исходников как приложения');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-selfcheck-'));
const electronVersions = { node: process.versions.node, electron: '38.8.6' };
const good = await runSelfCheck({ appPath: root, userData, version: '1.0', systemCa: 300, versions: electronVersions, safeStorage: { isEncryptionAvailable: () => true } });
check('всё на месте — ok', good.ok, JSON.stringify(good.checks.filter((c) => !c.ok)));
check('проверки: файлы, навыки, модули, данные, оболочка, Node, ключи, сертификаты', ['файл renderer/index.html', 'встроенные навыки', 'модуль pdf-lib', 'запись в папку данных', 'встроенный Node.js', 'хранилище ключей ОС', 'системные корневые сертификаты'].every((n) => good.checks.some((c) => c.name === n)) && good.checks.some((c) => /оболочка/.test(c.name)));
check('проба записи убрана', fs.readdirSync(userData).length === 0);
check('без Electron (чистый Node) — «встроенный Node.js» не ok', !(await runSelfCheck({ appPath: root, userData, versions: { node: '22' } })).checks.find((c) => c.name === 'встроенный Node.js').ok);

console.log('[3] сломанная установка');
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-selfcheck-app-'));
const bad = await runSelfCheck({ appPath: empty, userData, platform: 'win32', systemCa: 0, env: {}, safeStorage: { isEncryptionAvailable: () => false }, importer: async (m) => { if (m === 'pdf-lib') throw new Error('Cannot find module'); } });
const failed = bad.checks.filter((c) => !c.ok).map((c) => c.name);
check('нет файлов, навыков, модуля — не ok', !bad.ok && failed.includes('файл renderer/index.html') && failed.includes('встроенные навыки') && failed.includes('модуль pdf-lib'), failed.join());
check('Windows без DPAPI — ошибка', failed.includes('хранилище ключей ОС'));
check('нет системных сертификатов — ошибка', failed.includes('системные корневые сертификаты'));
const viaFlag = await runSelfCheck({ appPath: root, userData, systemCa: 0, env: { NODE_OPTIONS: '--use-system-ca' } });
check('запасной путь NODE_OPTIONS засчитывается', viaFlag.checks.find((c) => c.name === 'системные корневые сертификаты').ok);
const linuxNoKeyring = await runSelfCheck({ appPath: root, userData, platform: 'linux', systemCa: 1, safeStorage: { isEncryptionAvailable: () => false } });
check('Linux без keyring — не ошибка', linuxNoKeyring.checks.find((c) => c.name === 'хранилище ключей ОС').ok);

console.log('[4] системные корневые сертификаты');
let set = null;
const n = applySystemCa({ getCACertificates: (kind) => (kind === 'system' ? ['B', 'C'] : ['A', 'B']), setDefaultCACertificates: (list) => (set = list) });
check('встроенные + системные без дублей', n === 3 && set.join() === 'A,B,C');
check('нет API — 0, без исключения', applySystemCa({}) === 0 && applySystemCa({ getCACertificates: () => { throw new Error('x'); }, setDefaultCACertificates: () => {} }) === 0);
check('в этом Node — работает по-настоящему', applySystemCa() > 0);

fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
