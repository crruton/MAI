/**
 * Хранилище чатов: файл на сессию, индекс, перенос старого sessions.json,
 * фильтр по проекту и поиск (A3.7, CC6.6, CC6.7).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore } from '../electron/lib/session-store.js';

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-sessions-'));
const projA = path.join(root, 'A');
const projB = path.join(root, 'B');

console.log('\n[1] Перенос старого sessions.json');
fs.writeFileSync(
  path.join(root, 'sessions.json'),
  JSON.stringify([
    { id: 'old-1', title: 'Старый чат', projectDir: projA, createdAt: '2026-01-01', updatedAt: '2026-01-02', messages: [{ role: 'user', content: 'настрой postgres' }] },
    { id: 'old-2', title: 'Другой', projectDir: projB, createdAt: '2026-01-01', updatedAt: '2026-01-03', messages: [] },
  ]),
  'utf8',
);
const store = createSessionStore(root);
const list = store.listSessions();
check('оба чата перенесены', list.length === 2, JSON.stringify(list));
check('новые первыми', list[0].id === 'old-2');
check('старый файл сохранён как .migrated', fs.existsSync(path.join(root, 'sessions.json.migrated')) && !fs.existsSync(path.join(root, 'sessions.json')));
check('у каждой сессии свой файл', fs.existsSync(path.join(root, 'sessions', 'old-1.json')));
check('сообщения на месте', store.getSession('old-1').messages[0].content === 'настрой postgres');
check('повторный запуск не переносит заново', createSessionStore(root).listSessions().length === 2);

console.log('\n[2] Создание, сохранение, удаление');
const s = store.createSession({ title: 'Новый', projectDir: projA, model: 'm' });
s.messages.push({ role: 'user', content: 'сделай отчёт по продажам' }, { role: 'assistant', content: 'готово' });
store.saveSession(s);
const meta = store.listSessions().find((m) => m.id === s.id);
check('индекс обновлён: число запросов', meta?.count === 1, JSON.stringify(meta));
const otherFile = fs.readFileSync(path.join(root, 'sessions', 'old-2.json'), 'utf8');
store.saveSession({ ...s, title: 'Переименован' });
check('сохранение одного чата не переписывает другие', fs.readFileSync(path.join(root, 'sessions', 'old-2.json'), 'utf8') === otherFile);
store.setSessionMode(s.id, 'plan');
const stale = { ...store.getSession(s.id), permissionMode: 'manual' };
store.saveSession(stale);
check('режим, выбранный посреди прогона, не откатывается', store.getSession(s.id).permissionMode === 'plan');
store.addSessionRules(s.id, 'allow', ['run_shell(npm test*)']);
check('правила сессии', store.getSession(s.id).permissionRules.allow[0] === 'run_shell(npm test*)');
store.deleteSession('old-2');
check('удалённый чат пропал из индекса и с диска', !store.listSessions().some((m) => m.id === 'old-2') && !fs.existsSync(path.join(root, 'sessions', 'old-2.json')));
check('несуществующий id — null', store.getSession('нет') === null && store.getSession('../index') === null);

console.log('\n[3] Фильтр по проекту и поиск');
check('только чаты проекта A', store.listSessions({ projectDir: projA }).every((m) => m.projectDir === projA) && store.listSessions({ projectDir: projA }).length === 2);
check('путь со слешем в конце — тот же проект', store.listSessions({ projectDir: `${projA}${path.sep}` }).length === 2);
const byTitle = store.listSessions({ query: 'переимен' });
check('поиск по заголовку', byTitle.length === 1 && byTitle[0].id === s.id);
const byText = store.listSessions({ query: 'postgres' });
check('поиск по тексту сообщений с фрагментом', byText.length === 1 && /postgres/.test(byText[0].match), JSON.stringify(byText));
check('нет совпадений — пусто', store.listSessions({ query: 'kubernetes' }).length === 0);

console.log('[прерванные прогоны] (CW5.2)');
const runStore = createSessionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-run-')));
const r1 = runStore.createSession({ title: 'a' });
const r2 = runStore.createSession({ title: 'b' });
runStore.setSessionRun(r1.id, { status: 'running', startedAt: 'x' });
runStore.setSessionRun(r2.id, { status: 'done' });
const copy = runStore.getSession(r1.id);
copy.run = { status: 'stale' };
copy.title = 'новое';
runStore.saveSession(copy);
check('run защищён от перезаписи прогоном', runStore.getSession(r1.id).run.status === 'running' && runStore.getSession(r1.id).title === 'новое');
check('run в индексе', runStore.listSessions().find((m) => m.id === r1.id).run === 'running');
const marked = runStore.markInterrupted();
check('после перезапуска running → interrupted, остальные не тронуты', marked.length === 1 && marked[0] === r1.id && runStore.getSession(r1.id).run.status === 'interrupted' && runStore.getSession(r2.id).run.status === 'done');
check('повторно — ничего', runStore.markInterrupted().length === 0);

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
