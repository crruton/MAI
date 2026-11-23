/**
 * Инструмент ocr (F19, ADR 0084): картинка, скан PDF постранично, отказы.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { ocrTools } from '../electron/lib/tools/ocr.js';
import { toolEntry, runToolCall } from '../electron/lib/tool-runner.js';
import { classifyTool } from '../electron/lib/policy.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 300)}`);
  }
}
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ocrt-')));
const t = ocrTools[0];
const entry = toolEntry(t.schema, { source: 'builtin', run: t.run, precheck: t.precheck });
const policy = { getMode: () => 'manual', getRules: () => ({}) };
const calls = [];
const ocr = async (file, opts) => {
  calls.push({ file, opts });
  return { engine: 'тест', text: `текст из ${path.basename(file)}` };
};
fs.writeFileSync(path.join(dir, 'скан.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
fs.writeFileSync(path.join(dir, 'a.txt'), 'x');

check('класс — чтение (без вопроса)', classifyTool('ocr') === 'read');
let out = await runToolCall({ entry, args: { path: 'скан.png', language: 'ru' }, ctx: { projectDir: dir, ocr }, policy });
check('картинка: текст и движок, язык передан', /\[OCR тест\] скан\.png:\nтекст из скан\.png/.test(out.content) && calls[0].opts.language === 'ru', out.content);
out = await runToolCall({ entry, args: { path: 'скан.png' }, ctx: { projectDir: dir }, policy });
check('вне приложения — понятный отказ', /OCR недоступен вне приложения/.test(out.content));
out = await runToolCall({ entry, args: { path: 'a.txt' }, ctx: { projectDir: dir, ocr }, policy });
check('не картинка и не PDF — отказ', /для картинок и PDF/.test(out.content));
out = await runToolCall({ entry, args: { path: 'нет.png' }, ctx: { projectDir: dir, ocr }, policy });
check('нет файла — отказ', /не найден/.test(out.content));

const doc = await PDFDocument.create();
doc.addPage([200, 200]);
doc.addPage([200, 200]);
fs.writeFileSync(path.join(dir, 'скан.pdf'), await doc.save());
const hasPoppler = !spawnSync('pdftoppm', ['-v']).error;
calls.length = 0;
out = await runToolCall({ entry, args: { path: 'скан.pdf' }, ctx: { projectDir: dir, ocr }, policy });
if (hasPoppler) check('скан PDF: по страницам через pdftoppm', /страниц 2/.test(out.content) && /## Страница 2\nтекст из page-2\.png/.test(out.content) && calls.length === 2, out.content);
else check('скан PDF без pdftoppm — понятный отказ', /нужен pdftoppm/.test(out.content), out.content);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
