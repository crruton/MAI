/**
 * Чаты: переименование, форк, импорт, срок хранения, автозаголовок (CC6.5, CC6.8, CC6.9, ADR 0073).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore } from '../electron/lib/session-store.js';
import { cleanTitle } from '../electron/lib/titles.js';

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-sess-'));
const store = createSessionStore(tmp);

console.log('[1] переименование');
const s = store.createSession({ title: 'Первый запрос длинный', projectDir: tmp, kind: 'task' });
s.messages = [
  { role: 'user', content: 'сделай отчёт', display: 'сделай отчёт' },
  { role: 'assistant', content: 'готово' },
  { role: 'user', content: 'добавь график' },
  { role: 'assistant', content: 'добавил' },
];
store.saveSession(s);
let r = store.renameSession(s.id, 'Отчёт  по продажам ', { auto: true });
check('автозаголовок ставится, пока имя не дано вручную', r.title === 'Отчёт по продажам' && !r.titleManual);
r = store.renameSession(s.id, 'Мой отчёт');
check('ручное имя помечается', r.title === 'Мой отчёт' && r.titleManual === true);
r = store.renameSession(s.id, 'Автоимя', { auto: true });
check('автозаголовок не затирает ручное имя', r.title === 'Мой отчёт');
const stale = store.getSession(s.id);
stale.title = 'Старое имя из прогона';
stale.titleManual = false;
store.saveSession(stale);
check('сохранение копии из прогона не затирает ручное имя', store.getSession(s.id).title === 'Мой отчёт');
check('пустое имя — отказ', store.renameSession(s.id, '   ') === null);
check('в списке — новое имя', store.listSessions().find((m) => m.id === s.id)?.title === 'Мой отчёт');

console.log('[2] форк');
store.setSessionDirs?.(s.id, ['/extra']);
const f = store.forkSession(s.id);
check('копия: новый id, та же история, вид и папки', f.id !== s.id && f.messages.length === 4 && f.kind === 'task' && f.title === 'Мой отчёт (копия)' && f.forkedFrom.id === s.id, JSON.stringify(f).slice(0, 300));
const part = store.forkSession(s.id, { upTo: 2 });
check('копия до сообщения', part.messages.length === 2 && part.messages[1].content === 'готово');
part.messages[0].content = 'изменено';
store.saveSession(part);
check('история копии независима', store.getSession(s.id).messages[0].content === 'сделай отчёт');
check('разрешения «на сессию» не копируются', JSON.stringify(f.permissionRules) === JSON.stringify({ allow: [], ask: [], deny: [] }) && !f.run);

console.log('[3] импорт');
const imported = store.importSession({ format: 'mai-chat', session: { id: s.id, title: 'Чужой', kind: 'code', run: { status: 'running' }, permissionRules: { allow: ['run_shell(*)'] }, messages: [{ role: 'user', content: 'привет' }, { role: 'evil', content: 'x' }, { role: 'assistant', content: { a: 1 } }] } });
check('импорт: новый id, без чужих правил и состояния, только известные роли', imported.id !== s.id && imported.messages.length === 2 && imported.messages[1].content === '{"a":1}' && imported.permissionRules.allow.length === 0 && !imported.run, JSON.stringify(imported).slice(0, 300));
let err = '';
try {
  store.importSession({ nope: true });
} catch (e) {
  err = e.message;
}
check('не чат — понятная ошибка', /нет messages/.test(err));

console.log('[4] срок хранения');
const old = store.createSession({ title: 'старый' });
const oldFull = store.getSession(old.id);
oldFull.updatedAt = '2020-01-01T00:00:00Z';
fs.writeFileSync(path.join(tmp, 'sessions', `${old.id}.json`), JSON.stringify(oldFull));
const index = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', 'index.json'), 'utf8')).map((m) => (m.id === old.id ? { ...m, updatedAt: '2020-01-01T00:00:00Z' } : m));
fs.writeFileSync(path.join(tmp, 'sessions', 'index.json'), JSON.stringify(index));
const running = store.createSession({ title: 'идёт' });
store.setSessionRun(running.id, { status: 'running' });
const idx2 = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', 'index.json'), 'utf8')).map((m) => (m.id === running.id ? { ...m, updatedAt: '2020-01-01T00:00:00Z' } : m));
fs.writeFileSync(path.join(tmp, 'sessions', 'index.json'), JSON.stringify(idx2));
check('0 — бессрочно', store.expiredSessions(0).length === 0);
check('старше срока — в списке, идущий — нет', JSON.stringify(store.expiredSessions(30)) === JSON.stringify([old.id]), JSON.stringify(store.expiredSessions(30)));

console.log('[5] автозаголовок моделью');
check('чистка ответа модели', cleanTitle('«Отчёт по продажам за март».\nлишнее') === 'Отчёт по продажам за март' && cleanTitle('Заголовок: Сверка банка') === 'Сверка банка' && cleanTitle('') === '');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
