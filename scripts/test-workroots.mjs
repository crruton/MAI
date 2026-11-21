/**
 * Рабочие папки чата (CW1.2, ADR 0045).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeRoots, resolveIn, subjectIn, rootOf, describeRoots } from '../electron/lib/workroots.js';
import { fsTools } from '../electron/lib/tools/fs.js';
import { shellTools, resolveCwd } from '../electron/lib/tools/shell.js';
import { toolEntry, runToolCall } from '../electron/lib/tool-runner.js';
import { dockerRunArgs } from '../electron/lib/shell-sandbox.js';
import { subjectOf, evaluate } from '../electron/lib/policy.js';

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
const err = (fn) => {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message;
  }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-roots-'));
const project = path.join(tmp, 'proj');
const docs = path.join(tmp, 'Документы');
const other = path.join(tmp, 'other', 'proj');
const secret = path.join(tmp, 'secret');
for (const d of [project, docs, other, secret]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(docs, 'отчёт.md'), 'ОТЧЁТ');
fs.writeFileSync(path.join(secret, 'x.txt'), 'СЕКРЕТ');

console.log('[1] папки');
const roots = normalizeRoots(project, [docs, docs, other, project]);
check('основная первой, дубли отброшены', roots.length === 3 && roots[0].primary && roots[0].dir === project);
check('кириллическое имя сохраняется', roots[1].name === 'Документы');
check('одинаковые имена различаются', roots[2].name === 'proj-2', JSON.stringify(roots));
check('@имя/путь', resolveIn(roots, '@Документы/отчёт.md') === path.join(docs, 'отчёт.md'));
check('@имя регистр не важен', resolveIn(roots, '@документы') === docs);
check('относительный — от проекта', resolveIn(roots, 'src/a.js') === path.join(project, 'src', 'a.js'));
check('абсолютный внутри добавленной — можно', resolveIn(roots, path.join(docs, 'a')) === path.join(docs, 'a'));
check('вне папок — ошибка с подсказкой', /вне рабочих папок чата.*Добавьте папку/.test(err(() => resolveIn(roots, path.join(secret, 'x.txt')))));
check('выход из @папки — ошибка', /выходит из папки @Документы/.test(err(() => resolveIn(roots, '@Документы/../secret/x.txt'))));
check('неизвестная @папка — ошибка со списком', /Нет рабочей папки @nope.*@Документы/.test(err(() => resolveIn(roots, '@nope/x'))));
check('allowOutside — можно', resolveIn(roots, path.join(secret, 'x.txt'), { allowOutside: true }) === path.join(secret, 'x.txt'));
check('предмет: проект — относительный', subjectIn(roots, path.join(project, 'src', 'a.js')) === 'src/a.js');
check('предмет: добавленная — @имя/путь', subjectIn(roots, path.join(docs, 'Q1', 'отчёт.md')) === '@Документы/Q1/отчёт.md');
check('вложенная папка — самая глубокая', rootOf(normalizeRoots(tmp, [docs]), path.join(docs, 'x')).name === 'Документы');
check('в промпте — список папок', /@Документы → /.test(describeRoots(roots)) && describeRoots(normalizeRoots(project)) === '');

console.log('[2] правила для добавленных папок');
const subj = subjectOf({ tool: 'write_file', cls: 'write', args: { path: '@Документы/отчёт.md' }, projectDir: project, roots });
check('предмет вызова — @Документы/отчёт.md', subj === '@Документы/отчёт.md', subj);
const rule = (rules) => evaluate({ tool: 'write_file', cls: 'write', subject: subj, mode: 'manual', rules }).action;
check('allow write_file(@Документы/**) — без вопроса', rule({ allow: ['write_file(@Документы/**)'] }) === 'allow');
check('allow на проект (src/**) не покрывает папку', rule({ allow: ['write_file(src/**)'] }) === 'ask');
check('«Авто»: правка в добавленной папке — молча', evaluate({ tool: 'write_file', cls: 'write', subject: subj, mode: 'smart' }).action === 'allow');

console.log('[3] инструменты');
const tool = (name) => {
  const def = [...fsTools, ...shellTools].find((t) => t.schema.function.name === name);
  return toolEntry(def.schema, { source: 'builtin', run: def.run, precheck: def.precheck, preview: def.preview });
};
const ctx = { projectDir: project, roots };
const bypass = { getMode: () => 'bypass', getRules: () => ({}) };
let out = await runToolCall({ entry: tool('read_file'), args: { path: '@Документы/отчёт.md' }, ctx, policy: bypass });
check('read_file в добавленной папке', /ОТЧЁТ/.test(out.content), out.content);
out = await runToolCall({ entry: tool('write_file'), args: { path: '@Документы/new.md', content: 'НОВОЕ' }, ctx, policy: bypass });
check('write_file в добавленной папке', fs.readFileSync(path.join(docs, 'new.md'), 'utf8') === 'НОВОЕ');
out = await runToolCall({ entry: tool('read_file'), args: { path: path.join(secret, 'x.txt') }, ctx, policy: bypass });
check('чтение вне папок — отказ', /вне рабочих папок/.test(out.content) && !/СЕКРЕТ/.test(out.content), out.content);
out = await runToolCall({ entry: tool('list_files'), args: { path: '@Документы' }, ctx, policy: bypass });
check('list_files по @папке', /отчёт\.md/.test(out.content), out.content);
out = await runToolCall({ entry: tool('delete_file'), args: { path: '@Документы' }, ctx: { ...ctx, trashDir: path.join(tmp, 'trash') }, policy: bypass });
check('добавленную папку целиком не удалить', /рабочую папку целиком/.test(out.content) && fs.existsSync(docs), out.content);
check('рабочая папка команды — @папка', resolveCwd(ctx, '@Документы') === docs);
check('рабочая папка вне — ошибка', /Рабочая папка:/.test(err(() => resolveCwd(ctx, secret))));
out = await runToolCall({ entry: tool('run_shell'), args: { command: process.platform === 'win32' ? 'dir /b' : 'ls', cwd: '@Документы' }, ctx, policy: bypass });
check('команда в добавленной папке', /отчёт\.md/.test(out.content), out.content);
check('без roots — как раньше, только проект', /вне проекта/.test(err(() => resolveIn(normalizeRoots(project), '../x'))));

console.log('[4] Docker-песочница');
const args = dockerRunArgs({ command: 'ls', projectDir: project, cwd: path.join(docs, 'Q1'), config: {}, name: 'n', roots });
check('добавленные папки смонтированы в /mnt', args.includes(`${docs}:/mnt/Документы`) && args.includes(`${other}:/mnt/proj-2`) && args.includes(`${project}:/workspace`));
check('рабочая папка — в /mnt/<имя>', args[args.indexOf('-w') + 1] === '/mnt/Документы/Q1');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
