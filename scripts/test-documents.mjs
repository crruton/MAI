/**
 * Документы: создание и чтение DOCX/XLSX (CW2.1, CW2.2, ADR 0049).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDocx, buildXlsx, buildPptx, docxToMarkdown, pptxToMarkdown, readXlsx, sheetsToText } from '../electron/lib/documents.js';
import { markdownToSlides } from '../electron/lib/export/pptx.js';
import { readZip } from '../electron/lib/export/unzip.js';
import { createZip } from '../electron/lib/export/zip.js';
import { documentTools } from '../electron/lib/tools/documents.js';
import { toolEntry, runToolCall } from '../electron/lib/tool-runner.js';
import { classifyTool, suggestRules } from '../electron/lib/policy.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-docs-'));

console.log('[1] ZIP');
const zip = createZip([{ name: 'a.txt', data: 'привет' }, { name: 'b/c.xml', data: '<x>'.repeat(1000), compress: true }]);
const files = readZip(zip);
check('чтение своего ZIP: без сжатия и deflate', files.get('a.txt').toString() === 'привет' && files.get('b/c.xml').toString().length === 3000);
let error = '';
try {
  readZip(Buffer.from('не zip'));
} catch (e) {
  error = e.message;
}
check('не ZIP — понятная ошибка', /не ZIP/.test(error));

console.log('[2] XLSX');
const xlsx = buildXlsx({
  sheets: [
    { name: 'Продажи', rows: [['Месяц', 'Сумма', 'Флаг'], ['Январь', 100, true], ['Февраль', '250.5', false], ['Итого', '=SUM(B2:B3)', ''], ['Код', '007', 'a;b']] },
    { name: 'Пустой', rows: [] },
    { name: 'Плохое/имя*', rows: [['x']] },
  ],
});
const sheets = readXlsx(xlsx);
check('три листа, имена очищены', sheets.length === 3 && sheets[0].name === 'Продажи' && sheets[2].name === 'Плохое имя', JSON.stringify(sheets.map((s) => s.name)));
check('числа — числами', sheets[0].rows[1][1] === 100 && sheets[0].rows[2][1] === 250.5);
check('формула сохранена', sheets[0].rows[3][1] === '=SUM(B2:B3)');
check('логические значения', sheets[0].rows[1][2] === true && sheets[0].rows[2][2] === false);
check('«007» остаётся текстом (ведущий ноль)', sheets[0].rows[4][1] === '007');
const sheetXml = readZip(xlsx).get('xl/worksheets/sheet1.xml').toString();
check('первая строка закреплена и жирная', /state="frozen"/.test(sheetXml) && /<c r="A1" t="inlineStr" s="1">/.test(sheetXml));
check('текст для агента — по строкам', /## Лист «Продажи» \(строк: 5\)/.test(sheetsToText(sheets)) && /4: Итого ; =SUM\(B2:B3\)/.test(sheetsToText(sheets)) && /"a;b"/.test(sheetsToText(sheets)));
check('markdown-таблица — тоже xlsx', readXlsx(buildXlsx({ markdown: '# Список\n\n| A | B |\n|---|---|\n| 1 | 2 |' }))[0].rows[1][0] === '1');
check('ограничение строк', readXlsx(buildXlsx({ sheets: [{ rows: Array.from({ length: 50 }, (_, i) => [i]) }] }), { maxRows: 10 })[0].truncated === true);

console.log('[3] DOCX');
const docx = buildDocx('## Раздел\n\nТекст & <тег> "кавычки".\n\n- пункт 1\n- пункт 2\n\n| Имя | Сумма |\n|---|---|\n| Аня | 10 |', { title: 'Отчёт' });
const md = docxToMarkdown(docx);
check('заголовки', /^# Отчёт/.test(md) && /## Раздел/.test(md), md);
check('спецсимволы', md.includes('Текст & <тег> "кавычки".'));
check('список', /- пункт 1\n\n- пункт 2/.test(md));
check('таблица — markdown', /\| Имя \| Сумма \|\n\| --- \| --- \|\n\| Аня \| 10 \|/.test(md), md);
const foreign = createZip([
  {
    name: 'word/document.xml',
    data: '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Чужой</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">a </w:t></w:r><w:r><w:tab/><w:t>b&amp;c</w:t></w:r></w:p></w:body></w:document>',
  },
]);
check('чужой DOCX: стиль Heading2, табуляция, сущности', docxToMarkdown(foreign) === '## Чужой\n\na \tb&c', JSON.stringify(docxToMarkdown(foreign)));

console.log('[4] инструменты');
const entry = (name) => {
  const def = documentTools.find((t) => t.schema.function.name === name);
  return toolEntry(def.schema, { source: 'builtin', run: def.run, precheck: def.precheck, preview: def.preview });
};
check('классы: create — write, read — read', classifyTool('create_document') === 'write' && classifyTool('read_document') === 'read');
check('правило «не спрашивать» — create_document(папка/**)', suggestRules({ tool: 'create_document', cls: 'write', subject: 'out/a.docx' })[0] === 'create_document(out/**)');
const ctx = { projectDir: tmp, beforeWrite: () => {} };
const asked = [];
const policy = { getMode: () => 'manual', getRules: () => ({}) };
let out = await runToolCall({ entry: entry('create_document'), args: { path: 'Отчёт.docx', title: 'Итоги', markdown: 'Всё хорошо.' }, ctx, policy, approve: async (req) => (asked.push(req), { allow: true }) });
check('создан docx после вопроса', /Создан документ/.test(out.content) && fs.existsSync(path.join(tmp, 'Отчёт.docx')) && asked.length === 1, out.content);
check('в запросе — diff текста документа', asked[0].diff && /# Итоги/.test(JSON.stringify(asked[0].diff)), JSON.stringify(asked[0].diff)?.slice(0, 200));
out = await runToolCall({ entry: entry('read_document'), args: { path: 'Отчёт.docx' }, ctx, policy });
check('read_document без вопроса', /# Итоги\n\nВсё хорошо\./.test(out.content), out.content);
out = await runToolCall({ entry: entry('create_document'), args: { path: 'Данные.xlsx', sheets: [{ name: 'Л', rows: [['a', 'b'], [1, 2], ['=A2+B2']] }] }, ctx, policy: { getMode: () => 'bypass', getRules: () => ({}) } });
check('создан xlsx', /листов: 1/.test(out.content), out.content);
out = await runToolCall({ entry: entry('read_document'), args: { path: 'Данные.xlsx' }, ctx, policy });
check('xlsx читается с формулой', /3: =A2\+B2/.test(out.content), out.content);
out = await runToolCall({ entry: entry('create_document'), args: { path: 'run.exe', markdown: 'x' }, ctx, policy: { getMode: () => 'bypass', getRules: () => ({}) } });
check('неподдерживаемый формат — отказ до вопроса', /не поддерживается/.test(out.content) && !fs.existsSync(path.join(tmp, 'run.exe')));
out = await runToolCall({ entry: entry('create_document'), args: { path: 'a.xlsx' }, ctx, policy: { getMode: () => 'bypass', getRules: () => ({}) } });
check('xlsx без листов — отказ', /нужны sheets/.test(out.content));
out = await runToolCall({ entry: entry('create_document'), args: { path: 'таблица.csv', sheets: [{ rows: [['Имя', 'Комментарий'], ['Аня', 'да; "нет"']] }] }, ctx, policy: { getMode: () => 'bypass', getRules: () => ({}) } });
const csv = fs.readFileSync(path.join(tmp, 'таблица.csv'), 'utf8');
check('csv: BOM для Excel, ; и кавычки', csv.startsWith('﻿Имя;Комментарий\r\n') && csv.includes('"да; ""нет"""'), JSON.stringify(csv));
out = await runToolCall({ entry: entry('read_document'), args: { path: '../secret.docx' }, ctx, policy });
check('вне рабочих папок — отказ', /вне проекта/.test(out.content), out.content);

console.log('[4б] PPTX (CW2.3)');
const deckMd = '# Итоги квартала\nОтдел продаж\n\n## Выручка\n- Рост 12% <важно> & "кавычки"\n  - Москва +20%\n- План выполнен\n\n## Дальше\n- Найм';
const slides = markdownToSlides(deckMd);
check('Markdown → слайды: титульный, пункты с уровнями', slides.length === 3 && slides[0].subtitle === 'Отдел продаж' && slides[1].bullets[1].level === 1, JSON.stringify(slides));
const pptx = buildPptx({ markdown: deckMd });
const back = pptxToMarkdown(pptx);
check('PPTX туда-обратно: заголовки и пункты, спецсимволы', /## Слайд 1: Итоги квартала/.test(back) && /- Рост 12% <важно> & "кавычки"/.test(back) && /## Слайд 3: Дальше\n- Найм/.test(back), back);
const pfiles = readZip(pptx);
check('части PowerPoint: презентация, мастер, макет, тема, 3 слайда', ['ppt/presentation.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml', 'ppt/slides/slide3.xml'].every((n) => pfiles.has(n)));
out = await runToolCall({ entry: entry('create_document'), args: { path: 'Отчёт.pptx', slides: [{ title: 'Титул', subtitle: 'подзаголовок' }, { title: 'Пункты', bullets: ['один', { text: 'два', level: 1 }] }] }, ctx, policy: { getMode: () => 'bypass', getRules: () => ({}) } });
check('create_document .pptx', /Создан документ/.test(out.content), out.content);
out = await runToolCall({ entry: entry('read_document'), args: { path: 'Отчёт.pptx' }, ctx, policy });
check('read_document .pptx', /## Слайд 2: Пункты\n- один\n- два/.test(out.content), out.content);
out = await runToolCall({ entry: entry('create_document'), args: { path: 'пусто.pptx' }, ctx, policy: { getMode: () => 'bypass', getRules: () => ({}) } });
check('pptx без слайдов — отказ', /нужны slides/.test(out.content));

console.log('[5] сторонний читатель (LibreOffice, если установлен)');
const soffice = spawnSync(process.platform === 'win32' ? 'soffice.exe' : 'soffice', ['--version'], { encoding: 'utf8', timeout: 20000 });
if (soffice.status === 0) {
  const outDir = path.join(tmp, 'lo');
  fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, 'calc.xlsx'), buildXlsx({ sheets: [{ name: 'Л', rows: [['a', 'b'], [2, 3], ['=A2*B2', '=SUM(A2:B2)']] }] }));
  spawnSync('soffice', ['--headless', '--convert-to', 'csv', '--outdir', outDir, path.join(outDir, 'calc.xlsx')], { timeout: 90000 });
  const csvOut = fs.existsSync(path.join(outDir, 'calc.csv')) ? fs.readFileSync(path.join(outDir, 'calc.csv'), 'utf8') : '';
  check('LibreOffice открывает xlsx и считает формулы', /6,5/.test(csvOut), JSON.stringify(csvOut));
  fs.writeFileSync(path.join(outDir, 'doc.docx'), buildDocx('## Раздел\n\nТекст абзаца.', { title: 'Отчёт' }));
  spawnSync('soffice', ['--headless', '--convert-to', 'txt:Text (encoded):UTF8', '--outdir', outDir, path.join(outDir, 'doc.docx')], { timeout: 90000 });
  const txt = fs.existsSync(path.join(outDir, 'doc.txt')) ? fs.readFileSync(path.join(outDir, 'doc.txt'), 'utf8') : '';
  check('LibreOffice открывает docx', /Отчёт/.test(txt) && /Текст абзаца/.test(txt), JSON.stringify(txt));
  fs.writeFileSync(path.join(outDir, 'deck.pptx'), buildPptx({ markdown: '# Титул\nподзаголовок\n\n## Слайд два\n- пункт' }));
  spawnSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', outDir, path.join(outDir, 'deck.pptx')], { timeout: 90000 });
  check('LibreOffice открывает pptx', fs.existsSync(path.join(outDir, 'deck.pdf')) && fs.statSync(path.join(outDir, 'deck.pdf')).size > 1000);
} else {
  console.log('  —    LibreOffice не установлен, пропуск');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
