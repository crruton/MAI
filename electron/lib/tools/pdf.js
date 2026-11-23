import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFName, PDFBool, PDFHexString, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList } from 'pdf-lib';
import { resolveInside, assertNotSecret } from './fs.js';
import { defaultFilledName } from './pdf-names.js';

export { defaultFilledName };

/**
 * PDF: объединение и выборка страниц, поля форм (CW2.4, ADR 0083).
 * Библиотека pdf-lib (MIT, чистый JS) — исключение из ADR 0049: правка
 * структуры PDF (перекрёстные ссылки, потоки объектов, AcroForm) своим кодом
 * слишком рискованна.
 */

const MAX_INPUT = 200 * 1024 * 1024;

/** Номера страниц из «1-3,5,8-» (с 1) → индексы с 0; пусто — все. */
export function parsePages(spec, count) {
  const text = String(spec ?? '').trim();
  if (!text) return Array.from({ length: count }, (_x, i) => i);
  const out = [];
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (!m || (!m[1] && !m[3])) throw new Error(`Неверные страницы «${part}»: нужно вроде 1-3,5,8-`);
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] ? Number(m[3]) : count) : from;
    if (from < 1 || to > count || from > to) throw new Error(`Страницы ${part} вне документа (страниц ${count})`);
    for (let p = from; p <= to; p += 1) out.push(p - 1);
  }
  return out;
}

async function loadPdf(ctx, rel) {
  const file = resolveInside(ctx, rel);
  assertNotSecret(ctx, file, 'чтение');
  if (!fs.existsSync(file)) throw new Error(`Файл не найден: ${file}`);
  const stat = fs.statSync(file);
  if (stat.size > MAX_INPUT) throw new Error(`PDF слишком большой: ${stat.size} байт`);
  try {
    return { file, doc: await PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: false }) };
  } catch (err) {
    if (/encrypt/i.test(err.message)) throw new Error(`${path.basename(file)} зашифрован — откройте его паролем и сохраните без защиты`);
    throw new Error(`${path.basename(file)} не разобран как PDF: ${err.message}`);
  }
}

function outputPath(ctx, rel) {
  const file = resolveInside(ctx, rel);
  assertNotSecret(ctx, file, 'запись');
  if (!/\.pdf$/i.test(file)) throw new Error('Итоговый файл — .pdf');
  return file;
}

/** Описание полей формы для модели. */
function describeField(field) {
  const name = field.getName();
  if (field instanceof PDFTextField) return { name, type: 'text', value: field.getText() ?? '' };
  if (field instanceof PDFCheckBox) return { name, type: 'checkbox', value: field.isChecked() };
  if (field instanceof PDFDropdown) return { name, type: 'dropdown', value: field.getSelected().join(', '), options: field.getOptions() };
  if (field instanceof PDFOptionList) return { name, type: 'list', value: field.getSelected().join(', '), options: field.getOptions() };
  if (field instanceof PDFRadioGroup) return { name, type: 'radio', value: field.getSelected() ?? '', options: field.getOptions() };
  return { name, type: field.constructor?.name || 'other', value: '' };
}

/**
 * Заполнение полей. Текст вне WinAnsi (кириллица) стандартный шрифт PDF не
 * нарисует — такое значение пишется в поле напрямую, а просмотрщику ставится
 * NeedAppearances: он сам отрисует текст своим шрифтом.
 */
export function fillForm(doc, values) {
  const form = doc.getForm();
  const filled = [];
  const missing = [];
  let needAppearances = false;
  for (const [name, raw] of Object.entries(values || {})) {
    let field;
    try {
      field = form.getField(name);
    } catch {
      missing.push(name);
      continue;
    }
    const value = raw;
    if (field instanceof PDFTextField) {
      const text = String(value ?? '');
      // Вне WinAnsi (кириллица и пр.) стандартный шрифт не нарисует — значение напрямую.
      if (/[^\x00-\xFF]/.test(text)) {
        field.acroField.setValue(PDFHexString.fromText(text));
        needAppearances = true;
      } else {
        field.setText(text);
      }
    } else if (field instanceof PDFCheckBox) {
      if (value === true || /^(да|yes|true|1|on|x|✓)$/i.test(String(value))) field.check();
      else field.uncheck();
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      const options = field.getOptions();
      const pick = options.find((o) => o.toLowerCase() === String(value).toLowerCase());
      if (!pick) throw new Error(`«${name}»: нет варианта «${value}» (есть: ${options.join(', ')})`);
      field.select(pick);
    } else if (field instanceof PDFRadioGroup) {
      const options = field.getOptions();
      const pick = options.find((o) => o.toLowerCase() === String(value).toLowerCase());
      if (!pick) throw new Error(`«${name}»: нет варианта «${value}» (есть: ${options.join(', ')})`);
      field.select(pick);
    } else {
      missing.push(name);
      continue;
    }
    filled.push(name);
  }
  if (needAppearances) form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  return { filled, missing, needAppearances };
}

export const pdfTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'pdf_merge',
        description:
          'Собрать PDF из нескольких файлов и/или выбрать страницы: inputs — по порядку, у каждого pages вроде "1-3,5" (пусто — все). ' +
          'Так же вырезаются страницы из одного файла. Исходные файлы не меняются.',
        parameters: {
          type: 'object',
          properties: {
            inputs: {
              type: 'array',
              items: { type: 'object', properties: { path: { type: 'string' }, pages: { type: 'string' } }, required: ['path'] },
            },
            output: { type: 'string', description: 'Итоговый .pdf' },
          },
          required: ['inputs', 'output'],
        },
      },
    },
    precheck(ctx, args) {
      if (!Array.isArray(args.inputs) || !args.inputs.length) return 'Нужен хотя бы один входной PDF';
      try {
        const out = outputPath(ctx, args.output);
        for (const item of args.inputs) {
          const file = resolveInside(ctx, item?.path);
          if (file === out) return 'Итоговый файл не может совпадать с входным — сохраните под новым именем';
          if (!fs.existsSync(file)) return `Файл не найден: ${file}`;
        }
      } catch (err) {
        return err.message;
      }
      return null;
    },
    async run(ctx, args) {
      const out = outputPath(ctx, args.output);
      const merged = await PDFDocument.create();
      const parts = [];
      for (const item of args.inputs) {
        const { file, doc } = await loadPdf(ctx, item.path);
        const indices = parsePages(item.pages, doc.getPageCount());
        const pages = await merged.copyPages(doc, indices);
        for (const page of pages) merged.addPage(page);
        parts.push(`${path.basename(file)}: ${indices.length}`);
      }
      const existed = fs.existsSync(out);
      ctx.beforeWrite?.(out);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, await merged.save());
      return `${existed ? 'Перезаписан' : 'Создан'} ${out}: страниц ${merged.getPageCount()} (${parts.join('; ')})`;
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'pdf_fields',
        description: 'Поля формы PDF (AcroForm): имя, тип, текущее значение, варианты. Заполнить — pdf_form.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    },
    async run(ctx, args) {
      const { file, doc } = await loadPdf(ctx, args.path);
      const fields = doc.getForm().getFields().map(describeField);
      if (!fields.length) return `${path.basename(file)}: полей формы нет (это не заполняемая форма — текст читай read_file)`;
      return `Поля формы ${path.basename(file)} (${fields.length}):\n${fields.map((f) => `- «${f.name}» · ${f.type}${f.value !== '' && f.value !== false ? ` · сейчас: ${f.value}` : ''}${f.options ? ` · варианты: ${f.options.join(', ')}` : ''}`).join('\n')}`;
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'pdf_form',
        description:
          'Заполнить форму PDF: values {имя поля: значение} (имена — из pdf_fields), сохранить в output ' +
          '(по умолчанию «<имя> (заполнено).pdf», исходник не меняется). Флажки — true/false, списки — один из вариантов. flatten: true — поля станут обычным текстом.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            values: { type: 'object', additionalProperties: true },
            output: { type: 'string' },
            flatten: { type: 'boolean' },
          },
          required: ['path', 'values'],
        },
      },
    },
    precheck(ctx, args) {
      if (!args.values || typeof args.values !== 'object' || !Object.keys(args.values).length) return 'Нужны values {имя поля: значение}; список полей — pdf_fields';
      return null;
    },
    async run(ctx, args) {
      const { file, doc } = await loadPdf(ctx, args.path);
      const out = outputPath(ctx, defaultFilledName(args));
      if (out === file) throw new Error('Итоговый файл не может совпадать с исходным — сохраните под новым именем');
      const result = fillForm(doc, args.values);
      if (!result.filled.length) return `Ни одно поле не заполнено: нет полей ${result.missing.join(', ')}. Посмотри список — pdf_form без values.`;
      if (args.flatten && !result.needAppearances) doc.getForm().flatten();
      ctx.beforeWrite?.(out);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      // С NeedAppearances внешний вид полей рисует просмотрщик — свой не пересчитываем.
      fs.writeFileSync(out, await doc.save({ updateFieldAppearances: !result.needAppearances }));
      const notes = [result.missing.length ? `нет полей: ${result.missing.join(', ')}` : '', result.needAppearances ? 'кириллица — отрисует просмотрщик (поля не «вплавлены»)' : ''].filter(Boolean);
      return `Заполнено ${result.filled.length} полей → ${out}${notes.length ? ` (${notes.join('; ')})` : ''}`;
    },
  },
];

