import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveInside, assertNotSecret } from './fs.js';

/**
 * Инструмент ocr (F19, ADR 0084): текст со скана или картинки — тем же OCR,
 * что и кнопка у вложения (движок ОС, Tesseract или модель MAI). Скан PDF —
 * постранично через pdftoppm, если он установлен. Само распознавание —
 * `ctx.ocr(filePath, { language })` из цикла агента (настройки OCR).
 */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
const MAX_PAGES = 10;
const MAX_TEXT = 40_000;

function pdfToImages(file, maxPages) {
  if (spawnSync('pdftoppm', ['-v']).error) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ocr-'));
  const run = spawnSync('pdftoppm', ['-png', '-r', '200', '-f', '1', '-l', String(maxPages), file, path.join(dir, 'page')], { timeout: 120_000 });
  if (run.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`pdftoppm: ${String(run.stderr || '').trim().slice(0, 200) || run.status}`);
  }
  return { dir, pages: fs.readdirSync(dir).filter((n) => n.endsWith('.png')).sort().map((n) => path.join(dir, n)) };
}

export const ocrTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'ocr',
        description:
          'Распознать текст на картинке или скане PDF (если read_file не нашёл в PDF текста). Возвращает текст; для PDF — по страницам (до 10, pages — сколько первых). ' +
          'language — например ru или en (по умолчанию из настроек OCR).',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, language: { type: 'string' }, pages: { type: 'number' } },
          required: ['path'],
        },
      },
    },
    precheck(ctx, args) {
      if (typeof ctx.ocr !== 'function') return 'OCR недоступен вне приложения';
      const file = resolveInside(ctx, args.path);
      assertNotSecret(ctx, file, 'чтение');
      if (!fs.existsSync(file)) return `Файл не найден: ${file}`;
      const ext = path.extname(file).toLowerCase();
      if (!IMAGE_EXT.has(ext) && ext !== '.pdf') return `OCR — для картинок и PDF, а не ${ext || 'файла без расширения'}`;
      return null;
    },
    async run(ctx, args) {
      const file = resolveInside(ctx, args.path);
      const opts = args.language ? { language: args.language } : {};
      if (path.extname(file).toLowerCase() !== '.pdf') {
        const r = await ctx.ocr(file, opts);
        const text = String(r.text || '').trim();
        return text ? `[OCR ${r.engine || ''}] ${path.basename(file)}:\n${text.slice(0, MAX_TEXT)}` : `На ${path.basename(file)} текст не найден (${r.engine || 'OCR'}).`;
      }
      const max = Math.min(Math.max(Math.round(Number(args.pages) || MAX_PAGES), 1), MAX_PAGES);
      const images = pdfToImages(file, max);
      if (!images) return 'Для OCR скана PDF нужен pdftoppm (poppler) — его нет. Сохраните страницы картинками и распознайте их.';
      try {
        const parts = [];
        let engine = '';
        for (const [i, page] of images.pages.entries()) {
          const r = await ctx.ocr(page, opts);
          engine = r.engine || engine;
          parts.push(`## Страница ${i + 1}\n${String(r.text || '').trim() || '(текст не найден)'}`);
          if (parts.join('\n').length > MAX_TEXT) break;
        }
        return `[OCR ${engine}] ${path.basename(file)}, страниц ${parts.length}:\n\n${parts.join('\n\n').slice(0, MAX_TEXT)}`;
      } finally {
        fs.rmSync(images.dir, { recursive: true, force: true });
      }
    },
  },
];
