import fs from 'node:fs';
import path from 'node:path';
import { removeTree } from './remove-tree.js';

/**
 * Чистильщик старых версий (N7, ADR 0103). Удаляет то, что больше не нужно,
 * только после стабильной работы новой версии:
 *   - старые копии встроенных навыков (`skills/.previous`, ADR 0101) — когда
 *     приложение проработало на текущей версии `stableDays` дней и копии
 *     старше `previousDays`;
 *   - длинный вывод инструментов (`tool-output`) старше `outputDays`;
 *   - временные папки превью, OCR, распаковки пакетов и слияния старше суток;
 *   - кеши каталогов маркетплейса, которых больше нет в настройках.
 * Рабочие копии git (worktree) и образы Docker только показываются: в них
 * может быть несохранённая работа или чужие контейнеры.
 *
 * Модуль не зависит от Electron.
 */

const DAY = 86_400_000;
const TMP_PATTERNS = [/^mai-previews$/, /^mai-code-ocr$/, /^mai-ocr-/, /^mai-package-/, /^mai-merge-/];

function sizeOf(p) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const e of fs.readdirSync(p)) total += sizeOf(path.join(p, e));
    return total;
  } catch {
    return 0;
  }
}

const mtime = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

const list = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/**
 * История версий: при смене версии запоминаем, с какого момента работает текущая.
 * Возвращает { current, since, previous } (новую запись при смене).
 */
export function trackVersion(history, version, now = Date.now()) {
  if (history?.current === version) return history;
  return { current: version, since: new Date(now).toISOString(), previous: history?.current || '' };
}

/** Стабильна ли текущая версия: проработала stableDays дней. */
export function isStable(history, { stableDays = 3, now = Date.now() } = {}) {
  const since = Date.parse(history?.since || '');
  return Number.isFinite(since) && now - since >= stableDays * DAY;
}

/**
 * План очистки: [{ id, kind, path, bytes, ageDays, reason, removable }].
 * `removable: false` — только показать (worktree, Docker).
 */
export function planCleanup({ dataDir, tmpDir, history = null, marketplaces = [], worktrees = [], now = Date.now(), stableDays = 3, previousDays = 14, outputDays = 7, tmpDays = 1 } = {}) {
  const items = [];
  const age = (p) => Math.floor((now - mtime(p)) / DAY);
  const add = (kind, p, reason, removable = true) => items.push({ id: `${kind}:${p}`, kind, path: p, bytes: sizeOf(p), ageDays: age(p), reason, removable });
  const stable = isStable(history, { stableDays, now });

  const prev = path.join(dataDir, 'skills', '.previous');
  for (const e of list(prev)) {
    if (!e.isDirectory()) continue;
    const p = path.join(prev, e.name);
    if (!stable) continue;
    if (age(p) >= previousDays) add('навык', p, `старая копия навыка ${e.name}; версия ${history.current} стабильна ${Math.floor((now - Date.parse(history.since)) / DAY)} дн.`);
  }

  const out = path.join(dataDir, 'tool-output');
  for (const e of list(out)) {
    const p = path.join(out, e.name);
    if (age(p) >= outputDays) add('вывод', p, `длинный вывод инструмента старше ${outputDays} дн.`);
  }

  if (tmpDir) {
    for (const e of list(tmpDir)) {
      if (!TMP_PATTERNS.some((re) => re.test(e.name))) continue;
      const p = path.join(tmpDir, e.name);
      if (age(p) >= tmpDays) add('временное', p, 'временная папка MAI (превью, OCR, распаковка, слияние)');
    }
  }

  const known = new Set((marketplaces || []).map((m) => m?.name).filter(Boolean));
  for (const e of list(path.join(dataDir, 'marketplaces'))) {
    if (!e.isDirectory() || known.has(e.name)) continue;
    add('кеш', path.join(dataDir, 'marketplaces', e.name), 'кеш каталога, которого нет в настройках');
  }

  for (const w of worktrees || []) {
    if (w?.dir && age(w.dir) >= 14) items.push({ id: `worktree:${w.dir}`, kind: 'рабочая копия', path: w.dir, bytes: sizeOf(w.dir), ageDays: age(w.dir), reason: `${w.branch || 'ветка'} не менялась ${age(w.dir)} дн. — удалите через /worktree, если она слита`, removable: false });
  }

  items.sort((a, b) => Number(b.removable) - Number(a.removable) || b.bytes - a.bytes);
  const bytes = items.filter((i) => i.removable).reduce((s, i) => s + i.bytes, 0);
  return { stable, version: history?.current || '', since: history?.since || '', bytes, items };
}

/**
 * Удалить выбранное. Удаляются только пути из свежего плана и только внутри
 * папки данных или временной папки — чужой путь из окна не пройдёт.
 */
export function applyCleanup(plan, ids, { dataDir, tmpDir } = {}) {
  const roots = [dataDir, tmpDir].filter(Boolean).map((r) => path.resolve(r) + path.sep);
  const wanted = new Set(ids || []);
  const removed = [];
  const skipped = [];
  let bytes = 0;
  for (const item of plan.items) {
    if (!wanted.has(item.id)) continue;
    const full = path.resolve(item.path);
    if (!item.removable || !roots.some((r) => full.startsWith(r))) {
      skipped.push(item.path);
      continue;
    }
    try {
      removeTree(full);
      removed.push(item.path);
      bytes += item.bytes;
    } catch {
      skipped.push(item.path);
    }
  }
  return { removed, skipped, bytes };
}

/** «1,2 МБ». */
export function formatBytes(n) {
  if (n < 1024) return `${n} Б`;
  const units = ['КБ', 'МБ', 'ГБ'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1).replace('.', ',')} ${units[i]}`;
}
