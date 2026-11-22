/**
 * Файловая блокировка между процессами (F11, ADR 0062): файл `*.lock`
 * создаётся атомарно (flag wx). Старше 30 с — зависшая (процесс упал),
 * снимается. Повторный вход в том же процессе — без ожидания.
 *
 * Модуль не зависит от Electron.
 */
import fs from 'node:fs';

const STALE_MS = 30_000;
const WAIT_MS = 5_000;
const held = new Map(); // путь → глубина

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withFileLock(lockFile, fn, { staleMs = STALE_MS, waitMs = WAIT_MS, busyMessage = 'Файл занят другим процессом — повторите позже' } = {}) {
  if (held.get(lockFile)) {
    held.set(lockFile, held.get(lockFile) + 1);
    try {
      return fn();
    } finally {
      held.set(lockFile, held.get(lockFile) - 1);
    }
  }
  const started = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(lockFile, `${process.pid} ${new Date().toISOString()}`, { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lockFile).mtimeMs;
      } catch {
        continue; // блокировку только что сняли
      }
      if (age > staleMs) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() - started > waitMs) throw new Error(busyMessage);
      sleepSync(20 + Math.floor(Math.random() * 30));
    }
  }
  held.set(lockFile, 1);
  try {
    return fn();
  } finally {
    held.delete(lockFile);
    fs.rmSync(lockFile, { force: true });
  }
}
