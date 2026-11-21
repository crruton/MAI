/**
 * glob, edit_file, чтение перед правкой, лимит вывода (CC1.1, CC1.2, CC1.13, ADR 0054).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fsTools, globToRegExp } from '../electron/lib/tools/fs.js';
import { toolEntry, runToolCall, spillOutput, MAX_TOOL_OUTPUT } from '../electron/lib/tool-runner.js';
import { normalizeRoots } from '../electron/lib/workroots.js';

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-fstools-'));
const project = path.join(tmp, 'proj');
const write = (rel, text, mtime) => {
  const full = path.join(project, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  if (mtime) fs.utimesSync(full, mtime, mtime);
};
const tool = (name) => {
  const def = fsTools.find((t) => t.schema.function.name === name);
  return toolEntry(def.schema, { source: 'builtin', run: def.run, precheck: def.precheck, preview: def.preview });
};
const bypass = { getMode: () => 'bypass', getRules: () => ({}) };
const call = (ctx, name, args) => runToolCall({ entry: tool(name), args, ctx, policy: bypass }).then((r) => r.content);

console.log('[1] glob');
write('src/a.js', '1', new Date(2026, 0, 1));
write('src/deep/b.jsx', '2', new Date(2026, 5, 1));
write('src/c.ts', '3');
write('node_modules/x/index.js', 'x');
write('README.md', 'r');
const re = globToRegExp('src/**/*.{js,jsx}');
check('маска: ** и {a,b}', re.test('src/a.js') && re.test('src/deep/b.jsx') && !re.test('src/c.ts') && !re.test('lib/a.js'));
check('**/*.md — и в корне', globToRegExp('**/*.md').test('README.md') && globToRegExp('**/*.md').test('a/b/c.md'));
check('* не переходит через /', !globToRegExp('src/*.js').test('src/deep/b.js'));
const ctx = { projectDir: project };
let out = await call(ctx, 'glob', { pattern: '**/*.{js,jsx}' });
check('без node_modules, новые первыми', out.split('\n').join() === 'src/deep/b.jsx,src/a.js', out);
check('node_modules — если явно в маске', /node_modules\/x\/index\.js/.test(await call(ctx, 'glob', { pattern: 'node_modules/**/*.js' })));
check('ничего — понятный ответ', (await call(ctx, 'glob', { pattern: '**/*.py' })) === 'Файлов по маске нет');
check('вне проекта — отказ', /вне проекта/.test(await call(ctx, 'glob', { pattern: '*', path: '..' })));

console.log('[2] edit_file');
const rctx = { projectDir: project, readFiles: new Map() };
write('e.txt', 'a = 1\nb = 1\nc = 2\n');
out = await call(rctx, 'edit_file', { path: 'e.txt', old_string: 'c = 2', new_string: 'c = 3' });
check('без чтения — отказ', /Сначала прочитай/.test(out) && fs.readFileSync(path.join(project, 'e.txt'), 'utf8').includes('c = 2'), out);
await call(rctx, 'read_file', { path: 'e.txt' });
out = await call(rctx, 'edit_file', { path: 'e.txt', old_string: '= 1', new_string: '= 9' });
check('неоднозначно — отказ с подсказкой replace_all', /встречается 2 раз.*replace_all/.test(out), out);
out = await call(rctx, 'edit_file', { path: 'e.txt', old_string: '= 1', new_string: '= 9', replace_all: true });
check('replace_all', fs.readFileSync(path.join(project, 'e.txt'), 'utf8') === 'a = 9\nb = 9\nc = 2\n' && /замен: 2/.test(out), out);
out = await call(rctx, 'edit_file', { path: 'e.txt', edits: [{ old_string: 'a = 9', new_string: 'a = 0' }, { old_string: 'c = 2', new_string: 'c = 0' }] });
check('несколько правок по порядку', fs.readFileSync(path.join(project, 'e.txt'), 'utf8') === 'a = 0\nb = 9\nc = 0\n' && /правок: 2/.test(out), out);
out = await call(rctx, 'edit_file', { path: 'e.txt', edits: [{ old_string: 'a = 0', new_string: 'a = 5' }, { old_string: 'нет такого', new_string: 'x' }] });
check('правки атомарны: одна не нашлась — файл не тронут', /правка 2/.test(out) && fs.readFileSync(path.join(project, 'e.txt'), 'utf8') === 'a = 0\nb = 9\nc = 0\n', out);
check('одинаковые old/new — отказ', /совпадают/.test(await call(rctx, 'edit_file', { path: 'e.txt', old_string: 'b = 9', new_string: 'b = 9' })));
write('crlf.txt', 'строка 1\r\nстрока 2\r\nстрока 3\r\n');
await call(rctx, 'read_file', { path: 'crlf.txt' });
out = await call(rctx, 'edit_file', { path: 'crlf.txt', old_string: 'строка 1\nстрока 2', new_string: 'первая\nвторая' });
check('CRLF: фрагмент с LF находится, переводы строк файла сохраняются', fs.readFileSync(path.join(project, 'crlf.txt'), 'utf8') === 'первая\r\nвторая\r\nстрока 3\r\n', JSON.stringify(fs.readFileSync(path.join(project, 'crlf.txt'), 'utf8')));
fs.writeFileSync(path.join(project, 'e.txt'), 'изменён снаружи');
fs.utimesSync(path.join(project, 'e.txt'), new Date(2030, 0, 1), new Date(2030, 0, 1));
check('файл изменился после чтения — отказ', /изменился после чтения/.test(await call(rctx, 'edit_file', { path: 'e.txt', old_string: 'изменён', new_string: 'x' })));
check('после своей правки можно править дальше без нового чтения', !/прочитай/.test(await call(rctx, 'edit_file', { path: 'crlf.txt', old_string: 'первая', new_string: 'первая!' })));

console.log('[3] write_file');
out = await call(rctx, 'write_file', { path: 'README.md', content: 'новый' });
check('перезапись без чтения — отказ', /Сначала прочитай/.test(out) && fs.readFileSync(path.join(project, 'README.md'), 'utf8') === 'r');
out = await call(rctx, 'write_file', { path: 'brand-new.md', content: 'x' });
check('новый файл — без чтения можно', /Записано/.test(out));
check('без отметок (прямой вызов) — как раньше', /Записано/.test(await call({ projectDir: project }, 'write_file', { path: 'README.md', content: 'ok' })));

console.log('[4] лимит вывода');
const outputDir = path.join(tmp, 'out');
const long = Array.from({ length: 5000 }, (_, i) => `строка ${i}`).join('\n');
check('короткий — как есть', spillOutput({ outputDir }, 'x', 'коротко') === 'коротко');
const spilled = spillOutput({ outputDir }, 'run_shell', long);
const saved = fs.readdirSync(outputDir);
check('длинный — в файл целиком', saved.length === 1 && fs.readFileSync(path.join(outputDir, saved[0]), 'utf8') === long);
check('модели — начало, конец и путь @вывод', spilled.length < MAX_TOOL_OUTPUT + 400 && spilled.startsWith('строка 0') && spilled.endsWith('строка 4999') && spilled.includes(`@вывод/${saved[0]}`), spilled.length);
const roots = normalizeRoots(project, [{ dir: outputDir, name: 'вывод' }]);
out = await call({ projectDir: project, roots }, 'read_file', { path: `@вывод/${saved[0]}`, offset: 4000, limit: 2 });
check('агент дочитывает @вывод через read_file', /строка 3999\n.*строка 4000/.test(out), out);
const old = path.join(outputDir, 'old.txt');
fs.writeFileSync(old, 'x');
fs.utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
spillOutput({ outputDir }, 'x', long);
check('файлы старше 7 дней удаляются', !fs.existsSync(old));
check('без папки — обрезка', /обрезано/.test(spillOutput({}, 'x', long)));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
