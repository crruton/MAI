/**
 * Плановые задачи (бэклог CW5.1, ADR 0050).
 *
 * Задача: { id, title, prompt, projectDir, kind, model, enabled,
 *           schedule: { type: 'daily', time: 'HH:MM', days: [1..7] } | { type: 'interval', everyMinutes },
 *           createdAt, lastRun, lastStatus }.
 * Дни — ISO: 1 — понедельник … 7 — воскресенье. Время — местное.
 * Задачи — `<данные>/scheduled.json`, журнал запусков — `scheduled-runs.jsonl`.
 *
 * Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const MIN_INTERVAL = 15;

export function normalizeSchedule(raw = {}) {
  if (raw.type === 'interval') {
    const every = Math.max(MIN_INTERVAL, Math.min(7 * 24 * 60, Math.round(Number(raw.everyMinutes) || 60)));
    return { type: 'interval', everyMinutes: every };
  }
  const time = TIME_RE.test(String(raw.time || '')) ? String(raw.time) : '09:00';
  const days = [...new Set((Array.isArray(raw.days) ? raw.days : [1, 2, 3, 4, 5, 6, 7]).map(Number).filter((d) => d >= 1 && d <= 7))].sort();
  return { type: 'daily', time, days: days.length ? days : [1, 2, 3, 4, 5, 6, 7] };
}

const isoDay = (date) => ((date.getDay() + 6) % 7) + 1;

/** Ближайший запуск строго после `after`. */
export function nextRunAt(schedule, after = new Date(), lastRun = null) {
  const s = normalizeSchedule(schedule);
  const from = new Date(after);
  if (s.type === 'interval') {
    const base = lastRun ? new Date(lastRun) : from;
    const next = new Date(base.getTime() + s.everyMinutes * 60_000);
    return next > from ? next : new Date(from.getTime() + 60_000);
  }
  const [h, m] = s.time.split(':').map(Number);
  for (let i = 0; i <= 8; i += 1) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, h, m, 0, 0);
    if (day > from && s.days.includes(isoDay(day))) return day;
  }
  return null;
}

/** Последний плановый момент не позже `now` (для пропущенных запусков). */
export function previousRunAt(schedule, now = new Date()) {
  const s = normalizeSchedule(schedule);
  if (s.type === 'interval') return null;
  const [h, m] = s.time.split(':').map(Number);
  for (let i = 0; i <= 8; i += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, h, m, 0, 0);
    if (day <= now && s.days.includes(isoDay(day))) return day;
  }
  return null;
}

/**
 * Пора ли запускать. Для daily — если плановый момент наступил после
 * последнего запуска (и после создания): пропущенный запуск выполняется один
 * раз при следующей проверке. Для interval — прошло everyMinutes.
 */
export function isDue(task, now = new Date()) {
  if (!task?.enabled) return false;
  const s = normalizeSchedule(task.schedule);
  const last = task.lastRun ? new Date(task.lastRun) : null;
  if (s.type === 'interval') {
    const since = last || new Date(task.createdAt || now);
    return now.getTime() - since.getTime() >= s.everyMinutes * 60_000;
  }
  const prev = previousRunAt(s, now);
  if (!prev) return false;
  const created = new Date(task.createdAt || 0);
  if (prev < created) return false;
  // Пропущенное больше суток назад не догоняем: сводка за вчера уже не нужна.
  if (now.getTime() - prev.getTime() > 24 * 3600_000) return false;
  return !last || last < prev;
}

/** Описание расписания для окна. */
export function describeSchedule(schedule) {
  const s = normalizeSchedule(schedule);
  if (s.type === 'interval') return s.everyMinutes % 60 === 0 ? `каждые ${s.everyMinutes / 60} ч` : `каждые ${s.everyMinutes} мин`;
  const names = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
  const days = s.days.join() === '1,2,3,4,5,6,7' ? 'каждый день' : s.days.join() === '1,2,3,4,5' ? 'по будням' : s.days.map((d) => names[d]).join(', ');
  return `${days} в ${s.time}`;
}

export function createScheduleStore(dataDir) {
  const file = path.join(dataDir, 'scheduled.json');
  const runsFile = path.join(dataDir, 'scheduled-runs.jsonl');
  const read = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data.tasks) ? data.tasks : [];
    } catch {
      return [];
    }
  };
  const write = (tasks) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ tasks }, null, 2), 'utf8');
    fs.renameSync(temp, file);
  };
  const clean = (raw, previous = {}) => {
    const title = String(raw.title ?? previous.title ?? '').trim().slice(0, 120);
    const prompt = String(raw.prompt ?? previous.prompt ?? '').trim().slice(0, 20_000);
    if (!title) throw new Error('Нужно название задачи');
    if (!prompt) throw new Error('Нужно описание: что сделать');
    return {
      ...previous,
      id: previous.id || crypto.randomUUID(),
      title,
      prompt,
      projectDir: String(raw.projectDir ?? previous.projectDir ?? ''),
      kind: (raw.kind ?? previous.kind) === 'code' ? 'code' : 'task',
      model: String(raw.model ?? previous.model ?? ''),
      enabled: raw.enabled === undefined ? previous.enabled !== false : raw.enabled === true,
      schedule: normalizeSchedule(raw.schedule ?? previous.schedule),
      createdAt: previous.createdAt || new Date().toISOString(),
    };
  };
  return {
    list: read,
    get: (id) => read().find((t) => t.id === id) || null,
    save(raw) {
      const tasks = read();
      const index = tasks.findIndex((t) => t.id === raw.id);
      const task = clean(raw, index >= 0 ? tasks[index] : {});
      if (index >= 0) tasks[index] = task;
      else tasks.push(task);
      write(tasks);
      return task;
    },
    remove(id) {
      write(read().filter((t) => t.id !== id));
    },
    markRun(id, patch) {
      const tasks = read();
      const task = tasks.find((t) => t.id === id);
      if (!task) return null;
      Object.assign(task, patch);
      write(tasks);
      return task;
    },
    log(entry) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(runsFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
    },
    runs(id, limit = 20) {
      let lines = [];
      try {
        lines = fs.readFileSync(runsFile, 'utf8').trim().split('\n');
      } catch {
        return [];
      }
      return lines
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((r) => r && (!id || r.taskId === id))
        .slice(-limit)
        .reverse();
    },
  };
}
