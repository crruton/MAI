/**
 * Multica → OpenSpec (F14, ADR 0089): маркеры, статусы и галочки в tasks.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listChanges, taskMarker, parseTaskMarker, statusUpdatesFromIssues, applyTaskStatuses } from '../electron/lib/openspec.js';

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-openspec-'));
const write = (name, text) => {
  fs.mkdirSync(path.join(dir, 'openspec', 'changes', name), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec', 'changes', name, 'tasks.md'), text, 'utf8');
};
write('auth', '# Задачи\n\n- [ ] Вход через Keycloak\n- [ ] Роли из токена\n- [x] Выход\n');
write('crlf', '# Tasks\r\n\r\n- [ ] Windows line\r\n* [ ] Second one\r\n');

console.log('[1] маркеры');
const [auth] = listChanges(dir);
const id = (change, i) => listChanges(dir).find((c) => c.name === change).tasks[i].id;
check('маркер туда и обратно', JSON.stringify(parseTaskMarker(`текст\n\n${taskMarker('auth', id('auth', 0))}`)) === JSON.stringify({ change: 'auth', taskId: id('auth', 0) }));
check('без маркера — null', parseTaskMarker('просто описание') === null && parseTaskMarker('') === null);

console.log('[2] статусы Multica');
const issues = [
  { id: 'i1', key: 'MAI-1', status: 'done', description: `…\n${taskMarker('auth', id('auth', 0))}` },
  { id: 'i2', key: 'MAI-2', status: 'in_progress', description: taskMarker('auth', id('auth', 1)) },
  { id: 'i3', key: 'MAI-3', status: 'Cancelled', description: taskMarker('auth', id('auth', 1)) },
  { id: 'i4', key: 'MAI-4', status: 'Done', description: taskMarker('auth', id('auth', 2)) },
  { id: 'i5', key: 'MAI-5', status: 'done', description: 'задача без OpenSpec' },
  { id: 'i6', key: 'MAI-6', status: 'completed', description: taskMarker('crlf', id('crlf', 1)) },
  { id: 'i7', key: 'MAI-7', status: 'done', description: taskMarker('gone', 'old-task') },
  { id: 'i8', key: 'MAI-8', status: 'done', description: taskMarker('auth', 'renamed-task') },
];
const { updates, cancelled } = statusUpdatesFromIssues(issues);
check('«готово» любого регистра и completed — обновления', updates.map((u) => u.issue).join() === 'MAI-1,MAI-4,MAI-6,MAI-7,MAI-8', updates.map((u) => u.issue).join());
check('в работе — без обновления, отменённая — в отчёт', cancelled.length === 1 && cancelled[0].issue === 'MAI-3');

console.log('[3] галочки в tasks.md');
const dry = applyTaskStatuses(dir, updates, { dryRun: true });
check('dryRun ничего не пишет', dry.marked.length === 2 && !fs.readFileSync(path.join(auth.dir, 'tasks.md'), 'utf8').includes('[x] Вход'));
const report = applyTaskStatuses(dir, updates);
const authText = fs.readFileSync(path.join(auth.dir, 'tasks.md'), 'utf8');
check('отмечено: auth и crlf', report.marked.length === 2 && report.marked.some((m) => /Вход через Keycloak \(MAI-1\)/.test(m)), JSON.stringify(report.marked));
check('уже отмеченная — already', report.already.length === 1 && /Выход/.test(report.already[0]));
check('нет изменения или задачи — missing', report.missing.sort().join() === 'auth:renamed-task,gone:old-task', report.missing.join());
check('tasks.md: [x] на нужной строке, остальное не тронуто', authText === '# Задачи\n\n- [x] Вход через Keycloak\n- [ ] Роли из токена\n- [x] Выход\n', JSON.stringify(authText));
const crlfText = fs.readFileSync(path.join(dir, 'openspec', 'changes', 'crlf', 'tasks.md'), 'utf8');
check('CRLF сохранён, маркер «*» тоже', crlfText === '# Tasks\r\n\r\n- [ ] Windows line\r\n* [x] Second one\r\n', JSON.stringify(crlfText));
check('без временных файлов', !fs.readdirSync(auth.dir).some((f) => f.endsWith('.tmp')));
const again = applyTaskStatuses(dir, updates);
check('повторно — всё «уже отмечено»', again.marked.length === 0 && again.already.length === 3);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
