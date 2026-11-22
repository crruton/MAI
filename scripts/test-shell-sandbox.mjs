/**
 * Песочница для команд агента (CC2.8, ADR 0040).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeShellSandbox, hostAllowed, sandboxPlan, dockerRunArgs, DEFAULT_SHELL_SANDBOX, effectiveSandbox } from '../electron/lib/shell-sandbox.js';
import { shellTools } from '../electron/lib/tools/shell.js';

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

console.log('[1] настройки');
const def = normalizeShellSandbox();
check('по умолчанию выключено, без сети', def.mode === 'off' && def.network === 'none' && def.image === DEFAULT_SHELL_SANDBOX.image);
const bad = normalizeShellSandbox({ mode: 'docker', image: 'x; rm -rf /', network: 'host', memory: 'lots', cpus: '1e9', hostCommands: ['git *', '', 5] });
check('опасный образ отброшен', bad.image === DEFAULT_SHELL_SANDBOX.image);
check('сеть host не принимается', bad.network === 'none');
check('лимиты проверяются', bad.memory === '2g' && bad.cpus === '2');
check('маски очищены', bad.hostCommands.join('|') === 'git *|5');
check('сеть bridge по явному выбору', normalizeShellSandbox({ network: 'bridge' }).network === 'bridge');

console.log('[2] команды на хосте');
check('без масок — нет', hostAllowed('git status', []) === false);
check('git * — git status', hostAllowed('git status', ['git *']));
check('составная — каждая часть', hostAllowed('git add . && git commit -m x', ['git *']) && !hostAllowed('git add . && npm test', ['git *']));
check('подстановка — никогда', hostAllowed('git log $(whoami)', ['git *']) === false);
check('маска целиком, не префикс', hostAllowed('gitx status', ['git *']) === false);

console.log('[3] где выполнится');
const docker = { mode: 'docker', hostCommands: ['git *'] };
check('выключено — хост', sandboxPlan('npm test', {}).where === 'host');
check('docker — контейнер', sandboxPlan('npm test', docker, { dockerAvailable: true }).where === 'docker');
check('маска — хост', sandboxPlan('git status', docker, { dockerAvailable: false }).where === 'host');
const blocked = sandboxPlan('npm test', docker, { dockerAvailable: false });
check('Docker недоступен — отказ, не хост', blocked.where === 'blocked' && /Docker недоступен/.test(blocked.why));

console.log('[3б] режим «только в Задаче» и проект (CW1.3)');
check('tasks: «Задача» — docker, «Код» — хост', effectiveSandbox({ mode: 'tasks' }, { kind: 'task' }).mode === 'docker' && effectiveSandbox({ mode: 'tasks' }, { kind: 'code' }).mode === 'off');
check('проект сильнее общей настройки', effectiveSandbox({ mode: 'off' }, { kind: 'code', project: { sandbox: 'docker' } }).mode === 'docker' && effectiveSandbox({ mode: 'docker' }, { project: { sandbox: 'off' } }).mode === 'off' && effectiveSandbox({ mode: 'docker' }, { project: { sandbox: 'inherit' } }).mode === 'docker');
check('tasks в «Коде» — на хосте без проверки Docker', sandboxPlan('ls', { mode: 'tasks' }).where === 'host');
check('режим tasks сохраняется', normalizeShellSandbox({ mode: 'tasks' }).mode === 'tasks');

console.log('[4] аргументы docker run');
const proj = path.resolve(os.tmpdir(), 'proj');
const args = dockerRunArgs({ command: 'npm test && echo "ok"', projectDir: proj, cwd: path.join(proj, 'pkg', 'a'), config: { mode: 'docker' }, name: 'n1', uid: 1000, gid: 1000 });
const joined = args.join(' ');
check('одноразовый контейнер с именем', args[0] === 'run' && args.includes('--rm') && args[args.indexOf('--name') + 1] === 'n1');
check('без сети', args[args.indexOf('--network') + 1] === 'none');
check('ФС только на чтение, без capabilities', args.includes('--read-only') && joined.includes('--cap-drop ALL') && joined.includes('no-new-privileges'));
check('лимиты', joined.includes('--pids-limit 512') && joined.includes('--memory 2g') && joined.includes('--cpus 2'));
check('проект в /workspace', args.includes(`${proj}:/workspace`));
check('рабочая папка внутри', args[args.indexOf('-w') + 1] === '/workspace/pkg/a');
check('пользователь хоста', args[args.indexOf('--user') + 1] === '1000:1000');
check('команда — один аргумент sh -lc', args.slice(-3).join('|') === 'sh|-lc|npm test && echo "ok"');
const noUser = dockerRunArgs({ command: 'ls', projectDir: proj, cwd: '/elsewhere', config: {}, name: 'n2' });
check('без uid (Windows) — без --user', !noUser.includes('--user'));
check('папка вне проекта — /workspace', noUser[noUser.indexOf('-w') + 1] === '/workspace');

console.log('[5] run_shell через песочницу');
const run = shellTools.find((t) => t.schema.function.name === 'run_shell').run;
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-shellbox-'));
const blockedOut = await run({ projectDir: project, shellSandbox: { mode: 'docker' }, dockerAvailable: () => false }, { command: 'echo hi' });
check('Docker недоступен — команда не запускается', /Docker недоступен/.test(blockedOut) && !/код 0/.test(blockedOut), blockedOut);
const hostOut = await run({ projectDir: project, shellSandbox: { mode: 'docker', hostCommands: ['echo *'] }, dockerAvailable: () => false }, { command: 'echo host-ok' });
check('команда из списка — на хосте', /host-ok/.test(hostOut) && /код 0/.test(hostOut), hostOut);

if (process.platform !== 'win32') {
  // Поддельный docker: печатает аргументы — проверяем, что запускается именно docker run, без оболочки хоста.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-fakedocker-'));
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nif [ "$1" = run ]; then echo "ARGS:$*"; exit 3; fi\nexit 0\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  const dockOut = await run({ projectDir: project, shellSandbox: { mode: 'docker', image: 'alpine:3.20' } , dockerAvailable: () => true }, { command: 'echo $HOME; ls' });
  process.env.PATH = oldPath;
  check('вызван docker run с образом', /ARGS:run --rm -i --name mai-shell-/.test(dockOut) && /alpine:3\.20 sh -lc echo \$HOME; ls/.test(dockOut), dockOut);
  check('код возврата контейнера', /\[код 3, /.test(dockOut), dockOut);
  check('в итоге указано, где выполнено', /Docker alpine:3\.20, сеть выключена\]/.test(dockOut), dockOut);
  fs.rmSync(bin, { recursive: true, force: true });
} else {
  console.log('  —    поддельный docker на Windows не проверяется');
}
if (process.env.MAI_DOCKER_TEST === '1') {
  console.log('[6] настоящий Docker');
  const real = { projectDir: project, shellSandbox: { mode: 'docker', image: 'alpine:3.20' }, dockerAvailable: () => true };
  const write = await run(real, { command: 'echo из-контейнера > made.txt && cat /etc/os-release | head -1' });
  check('команда выполнилась в контейнере', /Alpine/.test(write) && /\[код 0, /.test(write), write);
  check('файл проекта записан и принадлежит пользователю', fs.readFileSync(path.join(project, 'made.txt'), 'utf8').trim() === 'из-контейнера' && fs.statSync(path.join(project, 'made.txt')).uid === process.getuid(), write);
  const net = await run(real, { command: 'wget -q -T 3 -O- http://example.com >/dev/null && echo NET || echo NONET' });
  check('сети нет', /NONET/.test(net), net);
  const root = await run(real, { command: 'touch /etc/x 2>&1; echo rc=$?' });
  check('корневая ФС только на чтение', /rc=1/.test(root), root);
  const outside = await run(real, { command: 'ls /workspace/.. | head -3; ls /home 2>&1 | head -1' });
  check('папки хоста вне проекта не видны', !outside.includes(os.homedir().split(path.sep).pop() || '\u0000'), outside);
  const started = Date.now();
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 1500);
  const stopped = await run({ ...real, signal: ctrl.signal }, { command: 'sleep 60' });
  check('«Стоп» останавливает контейнер', /остановлено пользователем/.test(stopped) && Date.now() - started < 20000, stopped);
}

fs.rmSync(project, { recursive: true, force: true });

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
