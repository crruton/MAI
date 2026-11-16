import { markdownToText } from './markdown.js';
import { markdownToDocx } from './docx.js';
import { markdownToXlsx } from './xlsx.js';

/**
 * Экспорт ответа агента в MD, TXT, DOCX и XLSX.
 *
 * Модуль чистый: не знает про Electron и файловую систему. Диалог сохранения
 * и запись файла — в `electron/main.js`. См. ADR 0025.
 */

/** Поддерживаемые форматы и их расширения. */
const FORMATS = {
  md: { ext: 'md', mime: 'text/markdown', name: 'Markdown' },
  txt: { ext: 'txt', mime: 'text/plain', name: 'Текст' },
  docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'Word' },
  xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'Excel' },
};

/**
 * Безопасное имя файла для Windows.
 *
 * Запрещённые символы заменяются на дефис, пробелы схлопываются, длина
 * ограничена. Зарезервированные имена (CON, PRN, NUL и т. п.) получают
 * подчёркивание.
 *
 * @param {string} raw
 * @param {string} ext
 * @returns {string}
 */
function safeFileName(raw, ext) {
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  let base = String(raw || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  if (!base) base = 'otvet';
  if (reserved.test(base)) base = `_${base}`;
  return `${base}.${ext}`;
}

/**
 * Имя файла по дате и теме.
 *
 * Тема берётся из первого заголовка ответа или из первого предложения.
 *
 * @param {string} markdown
 * @param {string} ext
 * @param {Date} [now]
 * @returns {string}
 */
function fileNameFor(markdown, ext, now = new Date()) {
  const text = String(markdown || '');
  const heading = text.match(/^\s*#{1,6}\s+(.+)$/m);
  let topic = heading ? heading[1] : '';
  if (!topic) {
    const firstLine = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('```'));
    topic = (firstLine || '').replace(/^[#>*\-\s]+/, '').slice(0, 60);
  }
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return safeFileName(`${date}-${topic || 'otvet'}`, ext);
}

/**
 * Собирает содержимое файла в нужном формате.
 *
 * @param {string} markdown
 * @param {'md'|'txt'|'docx'|'xlsx'} format
 * @param {{ title?: string }} [options]
 * @returns {{ data: Buffer, ext: string, mime: string }}
 */
function buildExport(markdown, format, options = {}) {
  const key = String(format || '').toLowerCase();
  const meta = FORMATS[key];
  if (!meta) {
    throw new Error(`Неизвестный формат экспорта: ${format}. Доступны: ${Object.keys(FORMATS).join(', ')}`);
  }
  const text = String(markdown || '');

  if (key === 'md') {
    // BOM не нужен: Markdown читают редакторы, а не Блокнот.
    return { data: Buffer.from(text, 'utf8'), ext: meta.ext, mime: meta.mime };
  }
  if (key === 'txt') {
    // BOM помогает Блокноту Windows определить UTF-8.
    return { data: Buffer.from(`\ufeff${markdownToText(text)}`, 'utf8'), ext: meta.ext, mime: meta.mime };
  }
  if (key === 'docx') {
    return { data: markdownToDocx(text, options), ext: meta.ext, mime: meta.mime };
  }
  return { data: markdownToXlsx(text, options), ext: meta.ext, mime: meta.mime };
}

/**
 * Собирает Markdown всего чата: заголовок, дата, затем сообщения.
 *
 * @param {Array<{ role: string, content?: string, display?: string }>} messages
 * @param {{ title?: string, now?: Date }} [options]
 * @returns {string}
 */
function chatToMarkdown(messages, options = {}) {
  const now = options.now || new Date();
  const stamp = now.toLocaleString('ru-RU');
  const title = options.title || 'Диалог MAI Code';
  const out = [`# ${title}`, '', `Дата: ${stamp}`, ''];

  for (const message of messages || []) {
    const role = message.role;
    if (role === 'user') {
      out.push('## Пользователь', '', String(message.display || message.content || '').trim(), '');
    } else if (role === 'assistant') {
      const text = String(message.content || '').trim();
      if (!text) continue;
      out.push('## MAI', '', text, '');
    }
    // Рантайм и системные сообщения в экспорт не попадают: это отладка.
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export { FORMATS, buildExport, fileNameFor, safeFileName, chatToMarkdown };
