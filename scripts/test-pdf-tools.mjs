/**
 * PDF: объединение, выборка страниц, поля форм (CW2.4, ADR 0083).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts, PDFName } from 'pdf-lib';
import { pdfTools, parsePages, defaultFilledName } from '../electron/lib/tools/pdf.js';
import { toolEntry, runToolCall } from '../electron/lib/tool-runner.js';
import { subjectOf, summarize, suggestRules, classifyTool } from '../electron/lib/policy.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`);
  }
}
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-pdft-')));
const ctx = { projectDir: dir };
const policy = { getMode: () => 'bypass', getRules: () => ({}) };
const entry = (name) => {
  const t = pdfTools.find((x) => x.schema.function.name === name);
  return toolEntry(t.schema, { source: 'builtin', run: t.run, precheck: t.precheck });
};

async function makePdf(file, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) doc.addPage([300, 200]).drawText(text, { x: 20, y: 100, size: 14, font });
  fs.writeFileSync(path.join(dir, file), await doc.save());
}
await makePdf('a.pdf', ['A1', 'A2', 'A3']);
await makePdf('b.pdf', ['B1', 'B2']);
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const form = doc.getForm();
  form.createTextField('fio').addToPage(page, { x: 20, y: 240, width: 300, height: 20 });
  form.createCheckBox('agree').addToPage(page, { x: 20, y: 200, width: 15, height: 15 });
  const dd = form.createDropdown('city');
  dd.addOptions(['Moscow', 'Kazan']);
  dd.addToPage(page, { x: 20, y: 160, width: 150, height: 20 });
  fs.writeFileSync(path.join(dir, 'анкета.pdf'), await doc.save());
}

console.log('[1] страницы');
check('«1-2,5» и «3-» → индексы', JSON.stringify(parsePages('1-2,5', 5)) === '[0,1,4]' && JSON.stringify(parsePages('3-', 4)) === '[2,3]' && parsePages('', 2).length === 2);
let threw = '';
try {
  parsePages('2-9', 3);
} catch (err) {
  threw = err.message;
}
check('вне документа — понятная ошибка', /вне документа \(страниц 3\)/.test(threw), threw);

console.log('[2] объединение');
let out = await runToolCall({ entry: entry('pdf_merge'), args: { inputs: [{ path: 'a.pdf', pages: '1,3' }, { path: 'b.pdf' }], output: 'итог.pdf' }, ctx, policy });
let merged = await PDFDocument.load(fs.readFileSync(path.join(dir, 'итог.pdf')));
check('A(1,3) + B(все) = 4 страницы, исходники целы', merged.getPageCount() === 4 && /страниц 4/.test(out.content) && (await PDFDocument.load(fs.readFileSync(path.join(dir, 'a.pdf')))).getPageCount() === 3, out.content);
out = await runToolCall({ entry: entry('pdf_merge'), args: { inputs: [{ path: 'a.pdf', pages: '2' }], output: 'стр2.pdf' }, ctx, policy });
check('вырезать страницу из одного файла', (await PDFDocument.load(fs.readFileSync(path.join(dir, 'стр2.pdf')))).getPageCount() === 1);
out = await runToolCall({ entry: entry('pdf_merge'), args: { inputs: [{ path: 'a.pdf' }], output: 'a.pdf' }, ctx, policy });
check('итог поверх входного — отказ', /не может совпадать/.test(out.content), out.content);
out = await runToolCall({ entry: entry('pdf_merge'), args: { inputs: [{ path: 'нет.pdf' }], output: 'x.pdf' }, ctx, policy });
check('нет входного файла — отказ до разрешения', /не найден/.test(out.content));

console.log('[3] формы');
out = await runToolCall({ entry: entry('pdf_fields'), args: { path: 'анкета.pdf' }, ctx, policy });
check('поля: имя, тип, варианты', /«fio» · text/.test(out.content) && /«agree» · checkbox/.test(out.content) && /«city» · dropdown · варианты: Moscow, Kazan/.test(out.content), out.content);
out = await runToolCall({ entry: entry('pdf_fields'), args: { path: 'a.pdf' }, ctx, policy });
check('PDF без формы — понятно', /полей формы нет/.test(out.content));
out = await runToolCall({ entry: entry('pdf_form'), args: { path: 'анкета.pdf', values: { fio: 'Ivanov Ivan', agree: true, city: 'kazan' } }, ctx, policy });
let filled = (await PDFDocument.load(fs.readFileSync(path.join(dir, 'анкета (заполнено).pdf')))).getForm();
check('латиница: текст, флажок, вариант без учёта регистра; файл «(заполнено)»', filled.getTextField('fio').getText() === 'Ivanov Ivan' && filled.getCheckBox('agree').isChecked() && filled.getDropdown('city').getSelected()[0] === 'Kazan' && /Заполнено 3 полей/.test(out.content), out.content);
out = await runToolCall({ entry: entry('pdf_form'), args: { path: 'анкета.pdf', values: { fio: 'Иванов Иван', nope: 1 }, output: 'кириллица.pdf' }, ctx, policy });
filled = await PDFDocument.load(fs.readFileSync(path.join(dir, 'кириллица.pdf')));
check('кириллица: значение в поле, NeedAppearances, отсутствующее поле названо', filled.getForm().getTextField('fio').getText() === 'Иванов Иван' && String(filled.getForm().acroForm.dict.get(PDFName.of('NeedAppearances'))) === 'true' && /кириллица — отрисует просмотрщик/.test(out.content) && /нет полей: nope/.test(out.content), out.content);
out = await runToolCall({ entry: entry('pdf_form'), args: { path: 'анкета.pdf', values: { city: 'Paris' }, output: 'x.pdf' }, ctx, policy });
check('нет варианта — ошибка с вариантами', /нет варианта «Paris» \(есть: Moscow, Kazan\)/.test(out.content), out.content);
out = await runToolCall({ entry: entry('pdf_form'), args: { path: 'анкета.pdf', values: { fio: 'Petrov' }, output: 'плоский.pdf', flatten: true }, ctx, policy });
check('flatten: полей больше нет', (await PDFDocument.load(fs.readFileSync(path.join(dir, 'плоский.pdf')))).getForm().getFields().length === 0, out.content);
out = await runToolCall({ entry: entry('pdf_form'), args: { path: 'анкета.pdf', values: {} }, ctx, policy });
check('без values — подсказка про pdf_fields', /pdf_fields/.test(out.content));

console.log('[4] разрешения');
check('классы: pdf_merge и pdf_form — запись, pdf_fields — чтение', classifyTool('pdf_merge') === 'write' && classifyTool('pdf_form') === 'write' && classifyTool('pdf_fields') === 'read');
check('предмет правила — итоговый файл', subjectOf({ tool: 'pdf_merge', cls: 'write', args: { inputs: [], output: 'out/итог.pdf' }, projectDir: dir }) === 'out/итог.pdf' && subjectOf({ tool: 'pdf_form', cls: 'write', args: { path: 'docs/анкета.pdf', values: {} }, projectDir: dir }) === 'docs/анкета (заполнено).pdf');
check('подсказка правила и текст запроса', suggestRules({ tool: 'pdf_merge', cls: 'write', subject: 'out/итог.pdf' })[0] === 'pdf_merge(out/**)' && /Собрать PDF out\/итог\.pdf: a\.pdf \(стр\. 1-2\) \+ b\.pdf/.test(summarize({ tool: 'pdf_merge', cls: 'write', args: { inputs: [{ path: 'a.pdf', pages: '1-2' }, { path: 'b.pdf' }] }, subject: 'out/итог.pdf' })));
check('имя по умолчанию', defaultFilledName({ path: 'анкета.pdf' }) === 'анкета (заполнено).pdf');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
