/**
 * Ноутбуки Jupyter: чтение по ячейкам и notebook_edit (CC1.10, ADR 0079).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fsTools } from '../electron/lib/tools/fs.js';
import { notebookTools, renderNotebook } from '../electron/lib/tools/notebook.js';
import { toolEntry, runToolCall } from '../electron/lib/tool-runner.js';

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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-nb-'));
const nbFile = path.join(dir, 'анализ.ipynb');
const nb = {
  cells: [
    { cell_type: 'markdown', id: 'm1', metadata: {}, source: ['# Анализ\n', 'продаж'] },
    { cell_type: 'code', id: 'c1', metadata: {}, execution_count: 3, source: ['import pandas as pd\n', 'df = pd.read_csv("x.csv")'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['ok\n'] }, { output_type: 'execute_result', data: { 'text/plain': ['   a\n0  1'], 'image/png': 'xx' }, metadata: {} }] },
    { cell_type: 'code', id: 'c2', metadata: {}, execution_count: null, source: [], outputs: [{ output_type: 'error', ename: 'NameError', evalue: "name 'q' is not defined", traceback: [] }] },
  ],
  metadata: { kernelspec: { language: 'python', name: 'python3' } },
  nbformat: 4,
  nbformat_minor: 5,
};
fs.writeFileSync(nbFile, `${JSON.stringify(nb, null, 1)}\n`);

const readFiles = new Map();
const ctx = { projectDir: dir, readFiles };
const read = toolEntry(fsTools.find((t) => t.schema.function.name === 'read_file').schema, { run: fsTools.find((t) => t.schema.function.name === 'read_file').run });
const def = notebookTools[0];
const edit = toolEntry(def.schema, { source: 'builtin', run: def.run, precheck: def.precheck, preview: def.preview });
const policy = { getMode: () => 'bypass', getRules: () => ({}) };
const reload = () => JSON.parse(fs.readFileSync(nbFile, 'utf8'));

console.log('[1] чтение');
const view = renderNotebook(nb);
check('ячейки с номерами, типами, id и счётчиком', /Ячейка 0 · markdown · id m1/.test(view) && /Ячейка 1 · code · id c1 · \[3\]/.test(view) && /```python\nimport pandas/.test(view), view.slice(0, 300));
check('вывод: поток, текст результата, тип картинки, ошибка', /ok/.test(view) && /0 {2}1/.test(view) && !/image\/png/.test(view.split('Ячейка 2')[0].split('0  1')[1] || 'x') && /NameError: name 'q'/.test(view));
let out = await runToolCall({ entry: edit, args: { path: 'анализ.ipynb', cell: 1, new_source: 'x' }, ctx, policy });
check('правка без чтения — отказ', /Сначала прочитай/.test(out.content), out.content);
out = await runToolCall({ entry: read, args: { path: 'анализ.ipynb' }, ctx, policy });
check('read_file показывает ноутбук по ячейкам', /Ноутбук Jupyter: ячеек 3/.test(out.content), out.content.slice(0, 200));

console.log('[2] правка');
out = await runToolCall({ entry: edit, args: { path: 'анализ.ipynb', cell: 1, new_source: 'import pandas as pd\ndf = pd.read_csv("y.csv")\n' }, ctx, policy });
let cur = reload();
check('замена: текст строками, вывод и счётчик сброшены', /изменена ячейка 1/.test(out.content) && JSON.stringify(cur.cells[1].source) === JSON.stringify(['import pandas as pd\n', 'df = pd.read_csv("y.csv")\n']) && cur.cells[1].outputs.length === 0 && cur.cells[1].execution_count === null, JSON.stringify(cur.cells[1]));
check('отступ файла сохранён (1 пробел), id на месте', /^\{\n "cells"/.test(fs.readFileSync(nbFile, 'utf8')) && cur.cells[1].id === 'c1');
out = await runToolCall({ entry: edit, args: { path: 'анализ.ipynb', cell_id: 'm1', edit_mode: 'insert', cell_type: 'markdown', new_source: '## Вывод' }, ctx, policy });
cur = reload();
check('вставка по id: ячейка markdown на его место, со своим id', cur.cells.length === 4 && cur.cells[0].cell_type === 'markdown' && cur.cells[0].source.join('') === '## Вывод' && cur.cells[0].id && !('outputs' in cur.cells[0]), JSON.stringify(cur.cells[0]));
out = await runToolCall({ entry: edit, args: { path: 'анализ.ipynb', edit_mode: 'insert', new_source: 'print(1)' }, ctx, policy });
cur = reload();
check('вставка без номера — в конец, ячейка кода с пустым выводом', cur.cells.length === 5 && cur.cells[4].cell_type === 'code' && Array.isArray(cur.cells[4].outputs));
out = await runToolCall({ entry: edit, args: { path: 'анализ.ipynb', cell: 3, edit_mode: 'delete' }, ctx, policy });
cur = reload();
check('удаление', cur.cells.length === 4 && !cur.cells.some((c) => c.id === 'c2'), out.content);
out = await runToolCall({ entry: edit, args: { path: 'анализ.ipynb', cell: 99, new_source: 'x' }, ctx, policy });
check('нет такой ячейки — понятный отказ', /Нет ячейки 99/.test(out.content), out.content);
fs.writeFileSync(path.join(dir, 'a.py'), 'x = 1\n');
out = await runToolCall({ entry: edit, args: { path: 'a.py', cell: 0, new_source: 'x' }, ctx, policy });
check('не .ipynb — отказ с подсказкой edit_file', /только для \.ipynb/.test(out.content), out.content);
const preview = def.preview(ctx, { path: 'анализ.ipynb', cell: 2, new_source: 'новое' });
check('превью для запроса разрешения — текст ячейки до и после', /read_csv/.test(preview.before) && preview.after === 'новое', JSON.stringify(preview));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
