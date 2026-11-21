/**
 * Защита от удаления и корзина (CW1.4, ADR 0044).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moveToTrash, listTrash, restoreFromTrash, purgeTrash } from '../electron/lib/trash.js';
import { fsTools } from '../electron/lib/tools/fs.js';
import { toolEntry, runToolCall } from '../electron/lib/tool-runner.js';
import { evaluate, classifyTool, suggestRules } from '../electron/lib/policy.js';

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-trash-'));
const project = path.join(tmp, 'proj');
const trash = path.join(tmp, 'trash');
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
  fs.writeFileSync(path.join(project, rel), text);
};

console.log('[1] корзина');
write('a.txt', 'AAA');
write('dir/b.txt', 'B');
write('dir/sub/c.txt', 'CC');
const metaA = moveToTrash(path.join(project, 'a.txt'), trash, { projectDir: project });
check('файл ушёл с места', !fs.existsSync(path.join(project, 'a.txt')));
check('запись с исходным путём и размером', metaA.original === path.join(project, 'a.txt') && metaA.bytes === 3 && metaA.files === 1);
const metaDir = moveToTrash(path.join(project, 'dir'), trash);
check('папка целиком, файлов 2', metaDir.dir === true && metaDir.files === 2);
check('список — новые сверху', listTrash(trash).map((i) => i.id).join() === [metaDir.id, metaA.id].join());
write('a.txt', 'новый');
let error = '';
try {
  restoreFromTrash(trash, metaA.id);
} catch (e) {
  error = e.message;
}
check('на месте есть файл — без overwrite не заменяет', /уже есть/.test(error) && fs.readFileSync(path.join(project, 'a.txt'), 'utf8') === 'новый');
restoreFromTrash(trash, metaA.id, { overwrite: true });
check('восстановлено с заменой', fs.readFileSync(path.join(project, 'a.txt'), 'utf8') === 'AAA' && listTrash(trash).length === 1);
restoreFromTrash(trash, metaDir.id);
check('папка восстановлена', fs.readFileSync(path.join(project, 'dir', 'sub', 'c.txt'), 'utf8') === 'CC');
check('неверный id — ошибка', (() => { try { restoreFromTrash(trash, '../x'); return false; } catch { return true; } })());
const old = moveToTrash(path.join(project, 'dir', 'b.txt'), trash);
check('старше 30 дней — очищается', purgeTrash(trash, { now: Date.now() + 31 * 86_400_000 }) === 1 && !listTrash(trash).some((i) => i.id === old.id));
moveToTrash(path.join(project, 'dir', 'sub'), trash);
check('очистить всё', purgeTrash(trash, { all: true }) === 1 && listTrash(trash).length === 0);

console.log('[2] решения по удалению');
const decide = (mode, rules = {}) => evaluate({ tool: 'delete_file', cls: classifyTool('delete_file'), subject: 'build/out.js', mode, rules, role: 'admin' }).action;
check('класс delete', classifyTool('delete_file') === 'delete');
check('Вручную — спросить', decide('manual') === 'ask');
check('Принимать правки — спросить', decide('acceptEdits') === 'ask');
check('Авто — спросить', decide('smart') === 'ask');
check('План — запрет', decide('plan') === 'deny');
check('Только разрешённое — запрет', decide('dontAsk') === 'deny');
check('Без вопросов — разрешено', decide('bypass') === 'allow');
check('правило allow по папке — без вопроса', decide('acceptEdits', { allow: ['delete_file(build/**)'] }) === 'allow');
check('правило на правки не разрешает удаление', decide('acceptEdits', { allow: ['write_file(**)', 'edit_file(**)'] }) === 'ask');
check('подсказка правила — только папка', suggestRules({ tool: 'delete_file', cls: 'delete', subject: 'build/out.js' })[0] === 'delete_file(build/**)' && suggestRules({ tool: 'delete_file', cls: 'delete', subject: 'x.js' }).length === 0);

console.log('[3] delete_file через цикл решений');
const def = fsTools.find((t) => t.schema.function.name === 'delete_file');
const entry = toolEntry(def.schema, { source: 'builtin', run: def.run, precheck: def.precheck, preview: def.preview });
write('src/old.js', 'old');
const checkpoints = [];
const ctx = { projectDir: project, trashDir: trash, beforeWrite: (f) => checkpoints.push(f) };
const asked = [];
const run = (args, mode, answer = { allow: true }) =>
  runToolCall({ entry, args, ctx, policy: { getMode: () => mode, getRules: () => ({}) }, approve: async (req) => (asked.push(req), answer) });
let out = await run({ path: 'src/old.js' }, 'acceptEdits', { allow: false });
check('отказ — файл на месте', out.ok === false && fs.existsSync(path.join(project, 'src', 'old.js')));
check('в запросе — удаление в корзину', asked[0]?.summary === 'Удалить src/old.js (в корзину)' && /корзину/.test(asked[0]?.why), JSON.stringify(asked[0]));
out = await run({ path: 'src/old.js' }, 'acceptEdits');
check('разрешено — в корзине', out.ok !== false && /в корзину/.test(out.content) && !fs.existsSync(path.join(project, 'src', 'old.js')) && listTrash(trash).length === 1, JSON.stringify(out));
check('файл записан в чекпоинт', checkpoints.includes(path.join(project, 'src', 'old.js')));
out = await run({ path: 'nope.js' }, 'bypass');
check('несуществующий — ошибка без вопроса', /Не найдено/.test(out.content) && asked.length === 2);
out = await run({ path: '.' }, 'bypass');
check('всю папку проекта — нельзя', /всю папку проекта/.test(out.content));
out = await run({ path: '../outside.txt' }, 'bypass');
check('вне проекта — нельзя', /вне проекта/.test(out.content));
write('.env', 'SECRET=1');
out = await run({ path: '.env' }, 'bypass');
check('секретный файл — guardrails', /Guardrails/.test(out.content) && fs.existsSync(path.join(project, '.env')));
const noTrash = await runToolCall({ entry, args: { path: 'a.txt' }, ctx: { projectDir: project }, policy: { getMode: () => 'bypass', getRules: () => ({}) } });
check('без корзины удаление выключено', /Корзина недоступна/.test(noTrash.content) && fs.existsSync(path.join(project, 'a.txt')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
