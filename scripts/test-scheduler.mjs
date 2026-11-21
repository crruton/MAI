/**
 * Плановые задачи (CW5.1, ADR 0050).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeSchedule, nextRunAt, previousRunAt, isDue, describeSchedule, createScheduleStore } from '../electron/lib/scheduler.js';

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
// Местное время: 2026-11-20 — пятница.
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m, 0, 0);
const weekdays = { type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] };

console.log('[1] расписание');
check('по умолчанию — каждый день в 09:00', JSON.stringify(normalizeSchedule({})) === JSON.stringify({ type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5, 6, 7] }));
check('плохое время — 09:00, плохие дни отброшены', normalizeSchedule({ time: '25:00', days: [0, 8, 3, 3] }).time === '09:00' && normalizeSchedule({ days: [0, 8, 3, 3] }).days.join() === '3');
check('интервал не меньше 15 минут', normalizeSchedule({ type: 'interval', everyMinutes: 1 }).everyMinutes === 15);
check('пятница 08:00 → пятница 09:00', nextRunAt(weekdays, at(20, 8)).getTime() === at(20, 9).getTime());
check('пятница 09:00 → понедельник 09:00 (строго после)', nextRunAt(weekdays, at(20, 9)).getTime() === at(23, 9).getTime());
check('суббота → понедельник', nextRunAt(weekdays, at(21, 12)).getTime() === at(23, 9).getTime());
check('интервал — от последнего запуска', nextRunAt({ type: 'interval', everyMinutes: 60 }, at(20, 10), at(20, 9, 30)).getTime() === at(20, 10, 30).getTime());
check('предыдущий: понедельник 08:00 → пятница 09:00', previousRunAt(weekdays, at(23, 8)).getTime() === at(20, 9).getTime());
check('описание', describeSchedule(weekdays) === 'по будням в 09:00' && describeSchedule({}) === 'каждый день в 09:00' && describeSchedule({ type: 'interval', everyMinutes: 120 }) === 'каждые 2 ч' && describeSchedule({ days: [6, 7], time: '10:30' }) === 'сб, вс в 10:30');

console.log('[2] пора ли запускать');
const task = { enabled: true, schedule: weekdays, createdAt: at(19, 12).toISOString(), lastRun: null };
check('до времени — нет', !isDue(task, at(20, 8, 59)));
check('в 09:00 — да', isDue(task, at(20, 9)));
check('после запуска в 09:01 — нет', !isDue({ ...task, lastRun: at(20, 9, 1).toISOString() }, at(20, 9, 30)));
check('приложение было закрыто в 09:00 — догнать в 11:00', isDue(task, at(20, 11)));
check('пропущенное больше суток назад — не догонять', !isDue({ ...task, lastRun: at(19, 9, 1).toISOString() }, at(21, 10)));
check('создана после планового момента — не запускать задним числом', !isDue({ ...task, createdAt: at(20, 9, 30).toISOString() }, at(20, 10)));
check('выключена — нет', !isDue({ ...task, enabled: false }, at(20, 9)));
check('выходной — нет', !isDue({ ...task, lastRun: at(20, 9, 1).toISOString() }, at(21, 9, 5)));
const interval = { enabled: true, schedule: { type: 'interval', everyMinutes: 30 }, createdAt: at(20, 9).toISOString() };
check('интервал: 29 минут — нет, 30 — да', !isDue(interval, at(20, 9, 29)) && isDue(interval, at(20, 9, 30)));

console.log('[3] хранилище и журнал');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-sched-'));
const store = createScheduleStore(dir);
let error = '';
try {
  store.save({ title: ' ', prompt: 'x' });
} catch (e) {
  error = e.message;
}
check('без названия — ошибка', /название/.test(error));
const saved = store.save({ title: 'Сводка', prompt: 'Собери сводку', schedule: weekdays, projectDir: '/p' });
check('сохранена: вид «Задача», включена, расписание очищено', saved.kind === 'task' && saved.enabled === true && saved.schedule.days.join() === '1,2,3,4,5' && saved.id);
const toggled = store.save({ id: saved.id, enabled: false });
check('изменение без переписывания остального', toggled.enabled === false && toggled.title === 'Сводка' && toggled.createdAt === saved.createdAt && store.list().length === 1);
store.markRun(saved.id, { lastRun: at(20, 9).toISOString(), lastStatus: 'ok' });
check('отметка запуска', store.get(saved.id).lastStatus === 'ok');
store.log({ taskId: saved.id, status: 'ok', summary: 'готово' });
store.log({ taskId: 'other', status: 'error' });
store.log({ taskId: saved.id, status: 'busy' });
const runs = store.runs(saved.id);
check('журнал по задаче, новые сверху', runs.length === 2 && runs[0].status === 'busy' && runs[1].summary === 'готово');
store.remove(saved.id);
check('удаление', store.list().length === 0);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
