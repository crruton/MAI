/**
 * Блокировка проекта на время прогона, который может менять файлы (бэклог A3.6).
 *
 * Чат, самокоррекция и внешние рантаймы работают в одной папке. Без блокировки
 * два агента одновременно правят одни и те же файлы, и результат одного
 * молча перезаписывает другой. Прогон в режиме «План» ничего не пишет и
 * блокировку не берёт.
 *
 * Блокировка живёт в памяти main-процесса: процесс один на приложение.
 */
import { folderKey } from './trust.js';

const locks = new Map();

/**
 * @returns {{ ok: true, release: () => void } | { ok: false, holder: object, error: string }}
 */
export function acquireProject(projectDir, owner) {
  const key = folderKey(projectDir);
  if (!key) return { ok: true, release: () => {} };
  const holder = locks.get(key);
  if (holder) {
    return {
      ok: false,
      holder,
      error: `Проект занят: ${holder.label} уже меняет файлы в этой папке. Дождитесь окончания или остановите его.`,
    };
  }
  const entry = { label: owner?.label || 'другой прогон', at: Date.now(), token: Symbol('lock') };
  locks.set(key, entry);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      if (locks.get(key)?.token === entry.token) locks.delete(key);
    },
  };
}

export function projectHolder(projectDir) {
  return locks.get(folderKey(projectDir)) || null;
}

export function listLocks() {
  return [...locks.entries()].map(([folder, entry]) => ({ folder, label: entry.label, at: entry.at }));
}
