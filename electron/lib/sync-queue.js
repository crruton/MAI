/**
 * Фоновая очередь автосинхронизации хранилища (F12, ADR 0087).
 *
 * Изменения артефактов копятся с задержкой (debounce), синхронизация идёт по одной
 * на проект; если во время прогона пришли новые правки — после него ещё один.
 * Ошибка → повтор с растущей паузой; после последней попытки — «ошибка» до
 * следующей правки или ручного запуска. Источник истины остаётся локальным.
 */
export function createSyncQueue({
  run,
  debounceMs = 5000,
  retryMs = [30_000, 120_000, 600_000],
  timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
  now = () => Date.now(),
  onChange = () => {},
} = {}) {
  if (typeof run !== 'function') throw new Error('createSyncQueue: нужен run(projectDir)');
  const items = new Map();

  const item = (projectDir) => {
    if (!items.has(projectDir)) {
      items.set(projectDir, { projectDir, state: 'idle', changes: 0, attempts: 0, dirty: false, timer: null, nextAt: 0, lastOkAt: 0, lastError: '', lastReport: null, reason: '' });
    }
    return items.get(projectDir);
  };

  const view = (it) =>
    it
      ? {
          projectDir: it.projectDir,
          state: it.state,
          changes: it.changes,
          attempts: it.attempts,
          nextAt: it.nextAt ? new Date(it.nextAt).toISOString() : '',
          lastOkAt: it.lastOkAt ? new Date(it.lastOkAt).toISOString() : '',
          lastError: it.lastError,
          lastReport: it.lastReport,
          reason: it.reason,
        }
      : { projectDir: '', state: 'idle', changes: 0, attempts: 0, nextAt: '', lastOkAt: '', lastError: '', lastReport: null, reason: '' };

  const emit = (it) => {
    try {
      onChange(view(it));
    } catch {
      /* слушатель не должен ломать очередь */
    }
  };

  const arm = (it, delay) => {
    if (it.timer) timers.clearTimeout(it.timer);
    it.nextAt = now() + delay;
    it.timer = timers.setTimeout(() => {
      it.timer = null;
      execute(it);
    }, delay);
  };

  async function execute(it) {
    if (it.state === 'running') {
      it.dirty = true;
      return;
    }
    it.state = 'running';
    it.nextAt = 0;
    it.dirty = false;
    const batch = it.changes;
    emit(it);
    try {
      it.lastReport = (await run(it.projectDir)) ?? null;
      it.state = 'ok';
      it.attempts = 0;
      it.lastError = '';
      it.lastOkAt = now();
      it.changes = Math.max(0, it.changes - batch);
      if (it.dirty || it.changes > 0) {
        it.state = 'pending';
        arm(it, debounceMs);
      }
    } catch (err) {
      it.lastError = String(err?.message || err).slice(0, 500);
      it.attempts += 1;
      if (it.dirty) {
        it.attempts = 0;
        it.state = 'pending';
        arm(it, debounceMs);
      } else if (it.attempts <= retryMs.length) {
        it.state = 'retry';
        arm(it, retryMs[it.attempts - 1]);
      } else {
        it.state = 'error';
      }
    }
    emit(it);
  }

  return {
    /** Отметить изменение: синхронизация через debounceMs (таймер сдвигается). */
    schedule(projectDir, reason = '') {
      if (!projectDir) return view(null);
      const it = item(projectDir);
      it.changes += 1;
      it.reason = String(reason || '').slice(0, 200);
      if (it.state === 'running') {
        it.dirty = true;
      } else {
        it.state = 'pending';
        it.attempts = 0;
        arm(it, debounceMs);
      }
      emit(it);
      return view(it);
    },
    /** Запустить сейчас (кнопка «Синхронизировать сейчас»). Ждёт завершения. */
    async flush(projectDir) {
      const it = item(projectDir);
      if (it.timer) timers.clearTimeout(it.timer);
      it.timer = null;
      it.attempts = 0;
      await execute(it);
      return view(it);
    },
    status(projectDir) {
      return view(items.get(projectDir));
    },
    /** Снять все таймеры (выход из приложения, выключение автосинхронизации). */
    stop() {
      for (const it of items.values()) {
        if (it.timer) timers.clearTimeout(it.timer);
        it.timer = null;
        it.nextAt = 0;
        if (it.state === 'pending' || it.state === 'retry') it.state = 'idle';
      }
    },
  };
}
