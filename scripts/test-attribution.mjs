/**
 * Атрибуция коммитов агента (E2.7, ADR 0116): трейлеры Agent-Model / Agent-User у простого
 * `git commit` в run_shell, итоговая команда в подтверждении, настоящий коммит в оболочке.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { attributeCommit, cleanTrailerValue, userLine, parseGitVersion, gitSupportsTrailer, localGitVersion } from '../electron/lib/attribution.js';
import { effectiveCommand } from '../electron/lib/tools/shell.js';
import { agentModelsFromCommits } from '../electron/lib/model-families.js';

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
const NEW = { gitVersion: [2, 45] };
const att = { model: 'agentrouter/claude-opus-5-5', user: 'Анна Петрова <anna@example.com>' };

console.log('[1] какие команды меняются');
let c = attributeCommit('git commit -m "Fix login"', att, NEW);
check('простой commit → два трейлера', c === 'git commit -m "Fix login" --trailer "Agent-Model: agentrouter/claude-opus-5-5" --trailer "Agent-User: Анна Петрова <anna@example.com>"', c);
check('с -c опциями git', attributeCommit('git -c core.editor=true commit -am "x"', att, NEW).includes('--trailer "Agent-Model:'));
check('без пользователя — только модель', attributeCommit('git commit -m x', { model: 'openai/gpt-5.1' }, NEW) === 'git commit -m x --trailer "Agent-Model: openai/gpt-5.1"');
for (const cmd of ['git status', 'git add . && git commit -m x', 'git commit -m "$(date)"', 'git commit -m x | tee log', 'echo git commit', 'git commit-tree abc', 'git commit -m x --trailer "Agent-Model: a/b"']) {
  check(`не меняется: ${cmd}`, attributeCommit(cmd, att, NEW) === cmd);
}
check('выключено в настройках', attributeCommit('git commit -m x', { ...att, enabled: false }, NEW) === 'git commit -m x');
check('нет данных — без изменений', attributeCommit('git commit -m x', {}, NEW) === 'git commit -m x' && attributeCommit('git commit -m x', null, NEW) === 'git commit -m x');
check('git < 2.32 — без трейлеров', attributeCommit('git commit -m x', att, { gitVersion: [2, 31] }) === 'git commit -m x');
check('версия git неизвестна — без трейлеров', attributeCommit('git commit -m x', att, { gitVersion: null }) === 'git commit -m x');

console.log('[2] значения');
check('опасные символы оболочки вырезаны', cleanTrailerValue('a"b`c$d%e!f\\g\nh') === 'abcdefg h');
check('пользователь Keycloak', userLine({ name: 'Анна Петрова', email: 'anna@example.com' }) === 'Анна Петрова <anna@example.com>');
check('только имя / только email / пусто', userLine({ preferred_username: 'anna' }) === 'anna' && userLine({ email: 'a@b.c' }) === '<a@b.c>' && userLine(null) === '');
check('email без пробелов и угловых скобок', userLine({ name: 'X', email: 'a <b>@c.d' }) === 'X <ab@c.d>');
check('версия git', JSON.stringify(parseGitVersion('git version 2.45.1.windows.1')) === '[2,45]' && gitSupportsTrailer([2, 32]) && gitSupportsTrailer([3, 0]) && !gitSupportsTrailer([2, 31]));

console.log('[3] итоговая команда в run_shell');
const eff = effectiveCommand({ attribution: att }, { command: 'git commit -m "Fix"' });
const local = localGitVersion();
if (gitSupportsTrailer(local)) check('effectiveCommand добавляет трейлеры (это и показывает подтверждение)', eff.includes('--trailer "Agent-Model: agentrouter/claude-opus-5-5"'), eff);
else check('старый git: команда без изменений', eff === 'git commit -m "Fix"', eff);
check('без атрибуции в контексте — как раньше', effectiveCommand({}, { command: 'git commit -m x' }) === 'git commit -m x');

console.log('[4] настоящий коммит через оболочку');
if (!gitSupportsTrailer(local)) {
  console.log(`  SKIP git ${local?.join('.') || 'не найден'} < 2.32`);
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-attr-'));
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(['add', '.']);
  const command = effectiveCommand({ attribution: att }, { command: 'git commit -q -m "Добавить файл"' });
  const r = spawnSync(command, { cwd: dir, shell: true, encoding: 'utf8' });
  const body = git(['log', '-1', '--format=%B']).stdout;
  check('коммит создан', r.status === 0, r.stderr);
  check('трейлеры в сообщении коммита', /Agent-Model: agentrouter\/claude-opus-5-5/.test(body) && /Agent-User: Анна Петрова <anna@example.com>/.test(body), body);
  const trailers = git(['log', '-1', '--format=%(trailers:key=Agent-Model,valueonly)']).stdout.trim();
  check('git видит Agent-Model как трейлер', trailers === 'agentrouter/claude-opus-5-5', trailers);
  check('MAI Ship читает модель исполнителя (ADR 0110)', agentModelsFromCommits([body]).join() === 'agentrouter/claude-opus-5-5');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nattribution: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
