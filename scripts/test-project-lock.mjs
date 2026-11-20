/**
 * Блокировка проекта на время пишущего прогона (бэклог A3.6).
 */
import path from 'node:path';
import os from 'node:os';
import { acquireProject, projectHolder, listLocks } from '../electron/lib/project-lock.js';

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

const dir = path.join(os.tmpdir(), 'mai-lock-project');
const other = path.join(os.tmpdir(), 'mai-lock-other');

console.log('\n[1] Один пишущий прогон на папку');
const chat = acquireProject(dir, { label: 'чат агента' });
check('первый прогон получил папку', chat.ok === true);
const correction = acquireProject(dir, { label: 'самокоррекция' });
check('второй прогон получил отказ', correction.ok === false);
check('в отказе назван владелец', /чат агента/.test(correction.error || ''), correction.error);
check('тот же путь со слешем — та же папка', acquireProject(`${dir}${path.sep}`, { label: 'x' }).ok === false);
check('другая папка свободна', acquireProject(other, { label: 'рантайм' }).ok === true);
check('владелец виден', projectHolder(dir)?.label === 'чат агента');

console.log('\n[2] Освобождение');
chat.release();
check('после release папка свободна', projectHolder(dir) === null);
const next = acquireProject(dir, { label: 'самокоррекция' });
check('следующий прогон получил папку', next.ok === true);
chat.release();
check('повторный release старого владельца не снимает чужую блокировку', projectHolder(dir)?.label === 'самокоррекция');
next.release();
check('пустой путь не блокирует', acquireProject('', { label: 'x' }).ok === true);
check('в списке остаётся только другая папка', listLocks().length === 1, JSON.stringify(listLocks()));

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
