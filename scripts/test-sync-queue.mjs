/**
 * Автосинхронизация хранилища (F12, ADR 0087): очередь с задержкой, повторами
 * (подписка на запись артефактов — в test-storage-safety, там Electron).
 */
import { createSyncQueue } from '../electron/lib/sync-queue.js';

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

/** Ручные таймеры: время двигаем сами. */
function fakeTimers() {
  let t = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      seq += 1;
      pending.set(seq, { at: t + ms, fn });
      return seq;
    },
    clearTimeout: (id) => pending.delete(id),
    count: () => pending.size,
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      }
      t = target;
      await new Promise((r) => setImmediate(r));
    },
  };
}

console.log('[1] задержка и склейка правок');
{
  const tm = fakeTimers();
  const runs = [];
  const q = createSyncQueue({ run: async (p) => runs.push(p) && { ok: true }, debounceMs: 1000, timers: tm, now: tm.now });
  q.schedule('/p', 'a');
  await tm.advance(500);
  q.schedule('/p', 'b');
  q.schedule('/p', 'c');
  check('до задержки — pending, ничего не запущено', q.status('/p').state === 'pending' && runs.length === 0 && q.status('/p').changes === 3);
  await tm.advance(900);
  check('таймер сдвигается новой правкой', runs.length === 0);
  await tm.advance(200);
  const s = q.status('/p');
  check('один прогон на три правки', runs.length === 1 && s.state === 'ok' && s.changes === 0, JSON.stringify(s));
  check('время успешной синхронизации', s.lastOkAt === new Date(1500).toISOString(), s.lastOkAt);
  check('неизвестный проект — idle', q.status('/other').state === 'idle');
}

console.log('[2] правка во время прогона → ещё один прогон');
{
  const tm = fakeTimers();
  let release;
  let runs = 0;
  const q = createSyncQueue({
    run: () => {
      runs += 1;
      return runs === 1 ? new Promise((r) => (release = r)) : Promise.resolve({ ok: true });
    },
    debounceMs: 100,
    timers: tm,
    now: tm.now,
  });
  q.schedule('/p');
  await tm.advance(100);
  check('идёт синхронизация', q.status('/p').state === 'running' && runs === 1);
  q.schedule('/p', 'во время');
  check('не запускает второй параллельно', runs === 1 && tm.count() === 0);
  release({ ok: true });
  await tm.advance(0);
  check('после прогона — снова в очереди', q.status('/p').state === 'pending', q.status('/p').state);
  await tm.advance(100);
  check('второй прогон прошёл', runs === 2 && q.status('/p').state === 'ok');
}

console.log('[3] ошибки: повтор с паузой, затем «ошибка»');
{
  const tm = fakeTimers();
  let runs = 0;
  const events = [];
  const q = createSyncQueue({
    run: async () => {
      runs += 1;
      throw new Error('Postgres: connection refused');
    },
    debounceMs: 10,
    retryMs: [100, 1000],
    timers: tm,
    now: tm.now,
    onChange: (s) => events.push(s.state),
  });
  q.schedule('/p');
  await tm.advance(10);
  let s = q.status('/p');
  check('первая ошибка — повтор через 100', s.state === 'retry' && s.attempts === 1 && s.nextAt === new Date(110).toISOString() && /refused/.test(s.lastError), JSON.stringify(s));
  await tm.advance(100);
  check('вторая — через 1000', q.status('/p').state === 'retry' && q.status('/p').attempts === 2);
  await tm.advance(1000);
  s = q.status('/p');
  check('попытки кончились — error, таймеров нет', s.state === 'error' && runs === 3 && tm.count() === 0 && !s.nextAt, JSON.stringify(s));
  check('слушатель видел состояния', events.join(',') === 'pending,running,retry,running,retry,running,error', events.join(','));
  q.schedule('/p');
  check('новая правка сбрасывает попытки', q.status('/p').state === 'pending' && q.status('/p').attempts === 0);
  q.stop();
  check('stop снимает таймеры', tm.count() === 0 && q.status('/p').state === 'idle');
}

console.log('[4] flush — «Синхронизировать сейчас»');
{
  const tm = fakeTimers();
  let runs = 0;
  const q = createSyncQueue({ run: async () => ({ ok: true, n: ++runs }), debounceMs: 5000, timers: tm, now: tm.now });
  q.schedule('/p');
  const s = await q.flush('/p');
  check('запускает сразу и снимает таймер', runs === 1 && s.state === 'ok' && s.lastReport?.n === 1 && tm.count() === 0, JSON.stringify(s));
  const s2 = await q.flush('/fresh');
  check('flush без правок — тоже прогон', runs === 2 && s2.state === 'ok');
  let threw = false;
  try {
    createSyncQueue({});
  } catch {
    threw = true;
  }
  check('без run — ошибка', threw);
}

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
