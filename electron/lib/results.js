/**
 * Результаты задачи (бэклог CW2.6, ADR 0047): файлы, которые агент создал или
 * изменил в чате. Источник — чекпоинты (ADR 0033): туда попадает каждая запись,
 * правка и удаление встроенными инструментами.
 *
 * «Открыть» программой по умолчанию — только для документов и изображений:
 * файл, созданный агентом, не должен запускаться (`.exe`, `.bat`, `.js`).
 *
 * Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import path from 'node:path';
import { touchedFiles } from './checkpoints.js';

export const OPENABLE = new Set([
  '.md', '.txt', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log',
  '.docx', '.doc', '.odt', '.rtf', '.xlsx', '.xls', '.ods', '.pptx', '.ppt', '.odp', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
]);
const TEXT = new Set(['.md', '.txt', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log', '.html', '.js', '.ts', '.py', '.css']);
const PREVIEW_CHARS = 4000;

export function canOpen(file) {
  return OPENABLE.has(path.extname(String(file)).toLowerCase());
}

/** Список для панели: новые сверху, с состоянием сейчас. */
export function sessionResults(dataDir, sessionId) {
  return touchedFiles(dataDir, sessionId)
    .map((item) => {
      let stat = null;
      try {
        stat = fs.statSync(item.file);
      } catch {
        stat = null;
      }
      const status = !stat ? 'deleted' : item.existedBefore ? 'changed' : 'created';
      return {
        ...item,
        name: path.basename(item.file),
        status,
        size: stat?.size ?? 0,
        modified: stat ? stat.mtime.toISOString() : null,
        openable: Boolean(stat) && canOpen(item.file),
        text: TEXT.has(path.extname(item.file).toLowerCase()),
      };
    })
    .sort((a, b) => b.turn - a.turn || a.name.localeCompare(b.name));
}

/** Файл из результатов чата или ошибка: окно не может открыть произвольный путь. */
export function resultFile(dataDir, sessionId, file) {
  const target = path.resolve(String(file || ''));
  const item = sessionResults(dataDir, sessionId).find((r) => path.resolve(r.file) === target);
  if (!item) throw new Error('Файл не из результатов этого чата');
  return item;
}

export function previewResult(dataDir, sessionId, file) {
  const item = resultFile(dataDir, sessionId, file);
  if (item.status === 'deleted') return { ...item, preview: '' };
  if (!item.text) return { ...item, preview: null };
  const fd = fs.openSync(item.file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(item.size, PREVIEW_CHARS * 4));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8').slice(0, PREVIEW_CHARS);
    return { ...item, preview: item.size > buffer.length || text.length >= PREVIEW_CHARS ? `${text}\n…` : text };
  } finally {
    fs.closeSync(fd);
  }
}
