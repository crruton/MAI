import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveInside, assertNotSecret } from './fs.js';
import { markdownToHtml, slidesToHtml } from '../export/html.js';
import { buildDocx, buildXlsx, buildPptx, docxToMarkdown, pptxToMarkdown, readXlsx, sheetsToText } from '../documents.js';

/**
 * Документы (CW2.1, CW2.2, ADR 0049): агент создаёт DOCX и XLSX и читает
 * существующие. Правка документа — прочитать, изменить, сохранить заново
 * (оформление исходника при этом не сохраняется — см. ADR).
 */
const WRITE_EXT = new Set(['.docx', '.xlsx', '.pptx', '.pdf', '.md', '.txt', '.csv']);
const MAX_TEXT = 60_000;

function textOf(ext, args) {
  if (ext === '.pptx') {
    const slides = Array.isArray(args.slides) && args.slides.length ? args.slides : null;
    if (!slides) return String(args.markdown || '');
    return slides.map((s, i) => [`## Слайд ${i + 1}: ${s.title || ''}`, ...(s.subtitle ? [s.subtitle] : []), ...(s.bullets || []).map((b) => `- ${typeof b === 'string' ? b : b?.text || ''}`)].join('\n')).join('\n\n');
  }
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
    if (ext === '.pptx') return pptxToMarkdown(fs.readFileSync(file));
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

const PREVIEW_EXT = new Set(['.docx', '.pptx', '.xlsx', '.csv', '.md', '.txt', '.pdf']);
const DAY = 24 * 60 * 60 * 1000;

/** Таблицы листов → Markdown для превью (первые 200 строк листа). */
function sheetsMarkdown(sheets) {
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return sheets
    .map((sheet) => {
      const rows = sheet.rows.slice(0, 200);
      if (!rows.length) return `## ${sheet.name}\n\n(пусто)`;
      const width = Math.max(...rows.map((r) => r.length), 1);
      const line = (r) => `| ${Array.from({ length: width }, (_x, i) => cell(r[i])).join(' | ')} |`;
      return [`## ${sheet.name}`, '', line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
    })
    .join('\n\n');
}

/** HTML-вид документа для превью; PDF — отдельно (pdftoppm). */
export function documentHtml(file) {
  const ext = path.extname(file).toLowerCase();
  const title = path.basename(file);
  if (ext === '.docx') return markdownToHtml(docxToMarkdown(fs.readFileSync(file)));
  if (ext === '.pptx') return slidesToHtml(pptxToMarkdown(fs.readFileSync(file)), { title });
  if (ext === '.xlsx') return markdownToHtml(sheetsMarkdown(readXlsx(fs.readFileSync(file), { maxRows: 200 })));
  if (ext === '.csv') {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const sep = text.split('\n', 1)[0].includes(';') ? ';' : ',';
    return markdownToHtml(sheetsMarkdown([{ name: title, rows: text.split(/\r?\n/).filter(Boolean).slice(0, 200).map((l) => l.split(sep)) }]));
  }
  if (ext === '.md') return markdownToHtml(fs.readFileSync(file, 'utf8'));
  return markdownToHtml(`\`\`\`\n${fs.readFileSync(file, 'utf8').slice(0, 100_000)}\n\`\`\``);
}

/** Папка для картинок превью; старше суток — удаляются. */
function previewFolder(ctx) {
  const base = ctx.previewDir || path.join(os.tmpdir(), 'mai-previews');
  fs.mkdirSync(base, { recursive: true });
  for (const name of fs.readdirSync(base)) {
    const full = path.join(base, name);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > DAY) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      /* занято — в следующий раз */
    }
  }
  return fs.mkdtempSync(path.join(base, 'p-'));
}

/** PDF → PNG через pdftoppm (poppler), если он установлен. */
function pdfPages(file, dir, maxPages) {
  const probe = spawnSync('pdftoppm', ['-v'], { encoding: 'utf8' });
  if (probe.error) return null;
  const run = spawnSync('pdftoppm', ['-png', '-r', '80', '-f', '1', '-l', String(maxPages), file, path.join(dir, 'page')], { encoding: 'utf8', timeout: 60_000 });
  if (run.status !== 0) throw new Error(`pdftoppm: ${(run.stderr || '').trim().slice(0, 200) || run.status}`);
  return fs.readdirSync(dir).filter((n) => n.endsWith('.png')).sort().map((n) => path.join(dir, n));
}

export const documentTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'create_document',
        description:
          'Создать документ: .docx или .pdf (из markdown: заголовки #, абзацы, списки, таблицы; PDF — A4), .pptx (из slides: [{ title, subtitle?, bullets }] ' +
          'или markdown: «## » — новый слайд, «- » — пункты, отступ — уровень), .xlsx (из sheets: листы со строками; ' +
          'числа — числами, строки с = — формулами, например "=SUM(B2:B10)"; первая строка — заголовок), .csv, .md или .txt. ' +
          'Существующий файл перезаписывается — для правки сначала прочитай его read_document; чтобы не потерять исходник, сохраняй под новым именем.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Путь с расширением: отчёт.docx, данные.xlsx, @Документы/итог.docx' },
            title: { type: 'string', description: 'Заголовок документа (для docx и md)' },
            markdown: { type: 'string', description: 'Содержимое для docx/md/txt' },
            slides: {
              type: 'array',
              description: 'Слайды для pptx; первый без bullets — титульный',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  subtitle: { type: 'string' },
                  bullets: { type: 'array', items: {} },
                },
                required: ['title'],
              },
            },
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
      if (ext === '.pptx' && !(Array.isArray(args.slides) && args.slides.length) && !args.markdown) return 'Для pptx нужны slides (или markdown со слайдами «## »)';
      if (!['.xlsx', '.csv', '.pptx'].includes(ext) && !args.markdown) return 'Нужен markdown — содержимое документа';
      if (ext === '.pdf' && typeof ctx.renderPdf !== 'function') return 'PDF создаётся только в приложении (нужен встроенный Chromium)';
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
      else if (ext === '.pptx') data = buildPptx({ slides: args.slides, markdown: args.markdown, title: args.title });
      else if (ext === '.pdf') data = await ctx.renderPdf(markdownToHtml(args.markdown, { title: args.title }));
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
        description: 'Прочитать документ: .docx — текстом в Markdown (заголовки, списки, таблицы), .pptx — по слайдам, .xlsx — листы по строкам (формулы как =…). Для обычных текстовых файлов — read_file.',
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
        else if (ext === '.pptx') text = pptxToMarkdown(fs.readFileSync(file));
        else if (ext === '.xlsx') text = sheetsToText(readXlsx(fs.readFileSync(file), { maxRows: Math.min(Math.max(Number(args.max_rows) || 500, 1), 5000) }));
        else return `Формат ${ext || 'без расширения'} читай инструментом read_file (docx и xlsx — здесь).`;
        return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… обрезано (${text.length} символов)` : text || '(документ пуст)';
      } catch (err) {
        return `Не удалось прочитать ${path.basename(file)}: ${err.message}`;
      }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'preview_document',
        description:
          'Посмотреть, как выглядит документ (.docx, .pptx, .xlsx, .csv, .md, .txt; .pdf — если установлен pdftoppm): страницы рендерятся в картинки и показываются тебе. ' +
          'Используй для самопроверки перед сдачей: вёрстка, пустые места, обрезанные таблицы, опечатки в заголовках. Нужна модель со зрением.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            pages: { type: 'number', description: 'Сколько первых страниц показать (1–4, по умолчанию 2)' },
          },
          required: ['path'],
        },
      },
    },
    precheck(ctx, args) {
      const file = resolveInside(ctx, args.path);
      assertNotSecret(ctx, file);
      const ext = path.extname(file).toLowerCase();
      if (!PREVIEW_EXT.has(ext)) return `Превью для ${ext || 'файла без расширения'} нет: docx, pptx, xlsx, csv, md, txt, pdf`;
      if (typeof ctx.vision === 'function' && !ctx.vision()) return 'Текущая модель не принимает изображения — проверь документ через read_document.';
      if (ext !== '.pdf' && typeof ctx.renderPng !== 'function') return 'Превью рисуется только в приложении (нужен встроенный Chromium) — проверь через read_document.';
      return null;
    },
    async run(ctx, args) {
      const file = resolveInside(ctx, args.path);
      assertNotSecret(ctx, file);
      if (!fs.existsSync(file)) return `Файл не найден: ${file}`;
      const ext = path.extname(file).toLowerCase();
      const maxPages = Math.min(Math.max(Math.round(Number(args.pages) || 2), 1), 4);
      const dir = previewFolder(ctx);
      let images;
      let total;
      if (ext === '.pdf') {
        images = pdfPages(file, dir, maxPages);
        if (!images) return 'Для превью PDF нужен pdftoppm (poppler) — его нет. Текст PDF читай read_file.';
        total = null;
      } else {
        const out = await ctx.renderPng(documentHtml(file), { maxPages });
        images = out.pages.map((png, i) => {
          const name = path.join(dir, `page-${i + 1}.png`);
          fs.writeFileSync(name, png);
          return name;
        });
        total = out.total;
      }
      if (!images.length) return `Превью ${path.basename(file)}: страниц нет`;
      const more = total && total > images.length ? ` из ${total}` : '';
      const note = ext === '.pdf' ? '' : ' Это приближённый вид: шрифты и поля Word/PowerPoint могут отличаться, содержание и структура — те же.';
      return {
        content: `Превью ${path.basename(file)}: страниц ${images.length}${more} — показаны тебе следующим сообщением.${note}`,
        images,
      };
    },
  },
];
