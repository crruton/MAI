import fs from 'node:fs';
import path from 'node:path';
import { resolveInside, assertNotSecret } from './fs.js';
import { buildDocx, buildXlsx, docxToMarkdown, readXlsx, sheetsToText } from '../documents.js';

/**
 * Документы (CW2.1, CW2.2, ADR 0049): агент создаёт DOCX и XLSX и читает
 * существующие. Правка документа — прочитать, изменить, сохранить заново
 * (оформление исходника при этом не сохраняется — см. ADR).
 */
const WRITE_EXT = new Set(['.docx', '.xlsx', '.md', '.txt', '.csv']);
const MAX_TEXT = 60_000;

function textOf(ext, args) {
  if (ext === '.xlsx') {
    if (Array.isArray(args.sheets) && args.sheets.length) return sheetsToText(args.sheets.map((s) => ({ name: s.name || 'Лист', rows: s.rows || [] })));
    return String(args.markdown || '');
  }
  if (ext === '.csv') return (args.sheets?.[0]?.rows || []).map((r) => r.join(';')).join('\n') || String(args.markdown || '');
  return `${args.title ? `# ${args.title}\n\n` : ''}${String(args.markdown || '')}`;
}

function currentText(file) {
  if (!fs.existsSync(file)) return '';
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === '.docx') return docxToMarkdown(fs.readFileSync(file));
    if (ext === '.xlsx') return sheetsToText(readXlsx(fs.readFileSync(file)));
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '(не удалось прочитать текущий файл)';
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const documentTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'create_document',
        description:
          'Создать документ: .docx (из markdown: заголовки #, абзацы, списки, таблицы), .xlsx (из sheets: листы со строками; ' +
          'числа — числами, строки с = — формулами, например "=SUM(B2:B10)"; первая строка — заголовок), .csv, .md или .txt. ' +
          'Существующий файл перезаписывается — для правки сначала прочитай его read_document; чтобы не потерять исходник, сохраняй под новым именем.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Путь с расширением: отчёт.docx, данные.xlsx, @Документы/итог.docx' },
            title: { type: 'string', description: 'Заголовок документа (для docx и md)' },
            markdown: { type: 'string', description: 'Содержимое для docx/md/txt' },
            sheets: {
              type: 'array',
              description: 'Листы для xlsx/csv',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  rows: { type: 'array', items: { type: 'array', items: {} } },
                  widths: { type: 'array', items: { type: 'number' } },
                },
                required: ['rows'],
              },
            },
          },
          required: ['path'],
        },
      },
    },
    precheck(ctx, args) {
      const file = resolveInside(ctx, args.path);
      assertNotSecret(ctx, file, 'запись');
      const ext = path.extname(file).toLowerCase();
      if (!WRITE_EXT.has(ext)) return `Формат ${ext || 'без расширения'} не поддерживается: docx, xlsx, csv, md, txt`;
      if (ext === '.xlsx' && !(Array.isArray(args.sheets) && args.sheets.length) && !args.markdown) return 'Для xlsx нужны sheets (или markdown с таблицами)';
      if (ext !== '.xlsx' && ext !== '.csv' && !args.markdown) return 'Нужен markdown — содержимое документа';
      return null;
    },
    /** Было/стало текстом — в запросе разрешения видно, что окажется в документе. */
    preview(ctx, args) {
      const file = resolveInside(ctx, args.path);
      const ext = path.extname(file).toLowerCase();
      return { before: currentText(file).slice(0, MAX_TEXT), after: textOf(ext, args).slice(0, MAX_TEXT) };
    },
    async run(ctx, args) {
      const file = resolveInside(ctx, args.path);
      assertNotSecret(ctx, file, 'запись');
      const ext = path.extname(file).toLowerCase();
      let data;
      if (ext === '.docx') data = buildDocx(args.markdown, { title: args.title });
      else if (ext === '.xlsx') data = buildXlsx({ sheets: args.sheets, markdown: args.markdown, title: args.title });
      else if (ext === '.csv') data = `\uFEFF${(args.sheets?.[0]?.rows || []).map((r) => r.map(csvCell).join(';')).join('\r\n') || String(args.markdown || '')}`;
      else data = textOf(ext, args);
      const existed = fs.existsSync(file);
      ctx.beforeWrite?.(file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      const size = fs.statSync(file).size;
      const sheets = ext === '.xlsx' && Array.isArray(args.sheets) ? `, листов: ${args.sheets.length}` : '';
      return `${existed ? 'Перезаписан' : 'Создан'} документ: ${file} (${size} байт${sheets}). Проверить содержимое — read_document.`;
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'read_document',
        description: 'Прочитать документ: .docx — текстом в Markdown (заголовки, списки, таблицы), .xlsx — листы по строкам (формулы как =…). Для обычных текстовых файлов — read_file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            max_rows: { type: 'number', description: 'Сколько строк листа xlsx показать (по умолчанию 500)' },
          },
          required: ['path'],
        },
      },
    },
    async run(ctx, args) {
      const file = resolveInside(ctx, args.path);
      assertNotSecret(ctx, file);
      if (!fs.existsSync(file)) return `Файл не найден: ${file}`;
      const ext = path.extname(file).toLowerCase();
      try {
        let text;
        if (ext === '.docx') text = docxToMarkdown(fs.readFileSync(file));
        else if (ext === '.xlsx') text = sheetsToText(readXlsx(fs.readFileSync(file), { maxRows: Math.min(Math.max(Number(args.max_rows) || 500, 1), 5000) }));
        else return `Формат ${ext || 'без расширения'} читай инструментом read_file (docx и xlsx — здесь).`;
        return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… обрезано (${text.length} символов)` : text || '(документ пуст)';
      } catch (err) {
        return `Не удалось прочитать ${path.basename(file)}: ${err.message}`;
      }
    },
  },
];
