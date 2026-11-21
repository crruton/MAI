/**
 * Результаты задачи (CW2.6, ADR 0047).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecorder, touchedFiles } from '../electron/lib/checkpoints.js';
import { sessionResults, resultFile, previewResult, canOpen } from '../electron/lib/results.js';

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-results-'));
const data = path.join(tmp, 'data');
const project = path.join(tmp, 'proj');
fs.mkdirSync(project, { recursive: true });
const file = (name) => path.join(project, name);
fs.writeFileSync(file('исходный.md'), 'было');
fs.writeFileSync(file('удалить.txt'), 'x');

const rec = createRecorder({ dataDir: data, sessionId: 's1', projectDir: project });
// Ход 0: создан отчёт, изменён исходный.
rec.record(file('отчёт.md'), 0);
fs.writeFileSync(file('отчёт.md'), '# Отчёт\n' + 'строка\n'.repeat(2000));
rec.record(file('исходный.md'), 0);
fs.writeFileSync(file('исходный.md'), 'стало');
// Ход 2: скрипт и удаление; повтор отчёта.
rec.record(file('run.bat'), 2);
fs.writeFileSync(file('run.bat'), 'echo hi');
rec.record(file('удалить.txt'), 2);
fs.rmSync(file('удалить.txt'));
rec.record(file('отчёт.md'), 2);

console.log('[1] список');
check('каждый файл один раз, по первому ходу', touchedFiles(data, 's1').length === 4 && touchedFiles(data, 's1').find((f) => f.file === file('отчёт.md')).turn === 0);
const items = sessionResults(data, 's1');
const by = (n) => items.find((i) => i.name === n) || {};
check('создан / изменён / удалён', by('отчёт.md').status === 'created' && by('исходный.md').status === 'changed' && by('удалить.txt').status === 'deleted', JSON.stringify(items.map((i) => [i.name, i.status])));
check('новые ходы сверху', items[0].turn === 2 && items.at(-1).turn === 0);
check('размер текущего файла', by('отчёт.md').size === fs.statSync(file('отчёт.md')).size);
check('документ открывается, .bat — нет', by('отчёт.md').openable && !by('run.bat').openable && !by('удалить.txt').openable);
check('расширения: docx, xlsx, pdf, png — да; exe, js, html — нет', ['a.docx', 'a.XLSX', 'a.pdf', 'a.png'].every(canOpen) && !['a.exe', 'a.js', 'a.html', 'a.lnk'].some(canOpen));
check('другой чат — пусто', sessionResults(data, 's2').length === 0);

console.log('[2] доступ только к своим файлам');
let error = '';
try {
  resultFile(data, 's1', path.join(tmp, 'other.txt'));
} catch (e) {
  error = e.message;
}
check('чужой путь — отказ', /не из результатов/.test(error));
error = '';
try {
  resultFile(data, 's2', file('отчёт.md'));
} catch (e) {
  error = e.message;
}
check('файл из другого чата — отказ', /не из результатов/.test(error));

console.log('[3] превью');
const pv = previewResult(data, 's1', file('отчёт.md'));
check('начало текста и многоточие', pv.preview.startsWith('# Отчёт') && pv.preview.endsWith('…') && pv.preview.length <= 4002, String(pv.preview.length));
check('кириллица не рвётся', !pv.preview.includes('�'));
fs.writeFileSync(path.join(project, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
rec.record(path.join(project, 'новое.png'), 3);
fs.writeFileSync(path.join(project, 'новое.png'), Buffer.from([0x89, 0x50]));
check('не текст — превью нет', previewResult(data, 's1', path.join(project, 'новое.png')).preview === null);
check('удалённый — пустое превью', previewResult(data, 's1', file('удалить.txt')).preview === '');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
