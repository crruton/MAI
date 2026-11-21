/**
 * Корзина приложения (бэклог CW1.4, ADR 0044).
 *
 * Агент не удаляет файлы пользователя: `delete_file` переносит файл или папку
 * в `<данные>/trash/<id>/`, рядом — `meta.json` с исходным путём. Восстановить —
 * в окне «Корзина» (`/trash`). Старше 30 дней — удаляется при следующем удалении.
 *
 * Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TRASH_DAYS = 30;
const ID_RE = /^[0-9]{13}-[0-9a-f]{8}$/;

function sizeOf(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) return { bytes: stat.size, files: 1 };
  let bytes = 0;
  let files = 0;
  for (const entry of fs.readdirSync(target)) {
    const inner = sizeOf(path.join(target, entry));
    bytes += inner.bytes;
    files += inner.files;
  }
  return { bytes, files };
}

/** Переносит в корзину. rename, а между дисками — копия и удаление. */
export function moveToTrash(target, trashDir, { projectDir = '' } = {}) {
  const source = path.resolve(target);
  if (!fs.existsSync(source)) throw new Error(`Не найдено: ${source}`);
  const { bytes, files } = sizeOf(source);
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(trashDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const stored = path.join(dir, path.basename(source));
  try {
    fs.renameSync(source, stored);
  } catch (err) {
    if (err.code !== 'EXDEV') {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    fs.cpSync(source, stored, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
  const meta = { id, original: source, name: path.basename(source), projectDir, deletedAt: new Date().toISOString(), bytes, files, dir: fs.statSync(stored).isDirectory() };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  purgeTrash(trashDir);
  return meta;
}

export function listTrash(trashDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(trashDir);
  } catch {
    return [];
  }
  const items = [];
  for (const id of entries) {
    if (!ID_RE.test(id)) continue;
    try {
      items.push(JSON.parse(fs.readFileSync(path.join(trashDir, id, 'meta.json'), 'utf8')));
    } catch {
      /* битая запись — пропускаем */
    }
  }
  return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/** Возвращает на место. Если там уже что-то есть — только с `overwrite`. */
export function restoreFromTrash(trashDir, id, { overwrite = false } = {}) {
  if (!ID_RE.test(String(id))) throw new Error('Неверный id');
  const dir = path.join(trashDir, id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const stored = path.join(dir, meta.name);
  if (fs.existsSync(meta.original)) {
    if (!overwrite) throw new Error(`На месте уже есть ${meta.original}`);
    fs.rmSync(meta.original, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(meta.original), { recursive: true });
  try {
    fs.renameSync(stored, meta.original);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(stored, meta.original, { recursive: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return meta;
}

/** Окончательно удаляет: одну запись, всё или старше TRASH_DAYS. */
export function purgeTrash(trashDir, { id = null, all = false, days = TRASH_DAYS, now = Date.now() } = {}) {
  let removed = 0;
  for (const item of listTrash(trashDir)) {
    const old = now - Date.parse(item.deletedAt) > days * 86_400_000;
    if (all || item.id === id || (!id && old)) {
      fs.rmSync(path.join(trashDir, item.id), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
