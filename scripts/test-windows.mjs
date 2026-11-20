/**
 * Проверки, которые имеют смысл только на настоящей Windows (CI: windows-latest).
 *
 * На Linux мы проверяли модель экранирования для cmd.exe и ветку taskkill
 * только «на бумаге». Здесь — настоящие .cmd-обёртки, cmd.exe, taskkill.
 * На других ОС тест сообщает о пропуске и выходит с кодом 0.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { startRuntime, spawnPlan } from '../electron/lib/runtimes.js';
import { execute, shellTools } from '../electron/lib/tools/shell.js';
import { createHookRunner, normalizeHooks } from '../electron/lib/hooks.js';
import { DEFAULT_GUARDRAILS, checkCommand } from '../electron/lib/guardrails.js';
import { runStage } from '../electron/lib/deploy.js';

if (process.platform !== 'win32') {
  console.log('Пропущено: не Windows.');
  console.log('\nИтог: 0 OK, 0 FAIL');
  process.exit(0);
}

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-win-'));
// Скрипт печатает свои аргументы и stdin как JSON — так видно, что дошло до процесса.
const echo = path.join(dir, 'echo.mjs');
fs.writeFileSync(
  echo,
  "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:s})));if(process.stdin.isTTY)process.stdin.emit('end');",
  'utf8',
);
// Как npm-обёртка в %APPDATA%\npm: node + скрипт + %*.
const shim = path.join(dir, 'fakecli.cmd');
fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`, 'utf8');

const run = (runtime, prompt, permissionMode = 'bypass') =>
  new Promise((resolve) => {
    let out = '';
    startRuntime({
      runtime,
      prompt,
      model: 'm',
      projectDir: dir,
      permissionMode,
      onData: (t) => (out += t),
      onExit: (r) => resolve({ ...r, out }),
    });
  });
const parse = (out) => {
  const start = out.indexOf('{');
  try {
    return JSON.parse(out.slice(start, out.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
};

console.log('\n[1] Запрос через настоящую .cmd-обёртку (ADR 0029)');
const tricky = 'одна & две | "три" %PATH% ^крышка (скобки) <угол> !восклиц';
{
  const r = await run({ name: 'fake', command: shim, args: ['{prompt}'] }, tricky);
  const got = parse(r.out);
  check('процесс запустился', r.code === 0, JSON.stringify(r).slice(0, 300));
  check('&, |, кавычки, ^, скобки, <>, ! дошли как есть', got?.argv?.[0] === tricky, JSON.stringify(got?.argv));
  check('%PATH% не раскрылся', got?.argv?.[0]?.includes('%PATH%'), JSON.stringify(got?.argv));
}
{
  const multi = 'первая строка\nвторая & строка';
  const r = await run({ name: 'fake', command: shim, args: ['{prompt}'] }, multi);
  const got = parse(r.out);
  check('многострочный запрос через cmd — одной строкой, без потери слов', got?.argv?.[0] === 'первая строка вторая & строка', JSON.stringify(got?.argv));
  check('об этом сказано в выводе', /одной строкой/.test(r.out));
  const viaStdin = await run({ name: 'fake', command: shim, args: ['{prompt}'], stdin: { arg: '' } }, multi);
  const got2 = parse(viaStdin.out);
  check('CLI со stdin получает многострочный запрос целиком', got2?.stdin === multi && !got2?.argv?.length, JSON.stringify(got2));
}
{
  const plan = spawnPlan('node', ['x']);
  check('node.exe запускается без cmd.exe', !plan.shim && /\.exe$/i.test(plan.file), JSON.stringify(plan));
  const shimPlan = spawnPlan(shim, ['a&b']);
  check('.cmd идёт через cmd.exe с verbatim-аргументами', shimPlan.shim && shimPlan.options.windowsVerbatimArguments === true);
}

console.log('\n[2] «Стоп» останавливает дерево процессов (taskkill /T)');
{
  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 800);
  // cmd → ping: без /T taskkill убил бы только cmd, а ping жил бы дальше.
  const out = await execute('ping -n 30 127.0.0.1 > nul', dir, { signal: ac.signal });
  check('команда остановлена быстро', Date.now() - started < 8000, `${Date.now() - started} мс`);
  check('в выводе отмечена остановка', /остановлено пользователем/.test(out), out.slice(-200));
  await new Promise((r) => setTimeout(r, 1500));
  const left = execSync('tasklist /FI "IMAGENAME eq PING.EXE" /NH', { encoding: 'utf8' });
  check('PING.EXE не остался', !/PING\.EXE/i.test(left), left.trim());
}
{
  const runShell = shellTools.find((t) => t.schema.function.name === 'run_shell');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const out = await runShell.run({ projectDir: dir, guardrails: DEFAULT_GUARDRAILS, repowise: {} }, { command: 'cd', cwd: 'sub' });
  check('run_shell: cwd внутри проекта', out.toLowerCase().includes(path.join(dir, 'sub').toLowerCase()), out.slice(0, 200));
  let error = '';
  try {
    await runShell.run({ projectDir: dir, guardrails: DEFAULT_GUARDRAILS, repowise: {} }, { command: 'cd', cwd: 'C:\\Windows' });
  } catch (err) {
    error = err.message;
  }
  check('run_shell: cwd вне проекта отклонён', /вне проекта/.test(error), error);
}

console.log('\n[2b] Кириллица в выводе cmd.exe');
{
  const out = await execute('echo живой текст', dir);
  check('run_shell: кириллица в выводе без кракозябр', out.includes('живой текст'), JSON.stringify(out.slice(0, 200)));
  const chunks = [];
  await execute('echo живой вывод', dir, { onData: (t) => chunks.push(t) });
  check('живой вывод тоже в UTF-8', chunks.join('').includes('живой вывод'), JSON.stringify(chunks));
  const stage = await new Promise((resolve) => runStage({ projectDir: dir, command: 'echo стадия собрана', onData: () => {}, onExit: resolve }));
  check('стадия доски: кириллица без кракозябр', String(stage.log || '').includes('стадия собрана'), JSON.stringify(stage).slice(0, 200));
}

console.log('\n[3] Guardrails на командах Windows');
for (const cmd of ['rd /s /q C:\\', 'del /f /s /q C:\\', 'format C:', 'Remove-Item -Recurse -Force C:\\']) {
  check(`заблокировано: ${cmd}`, !checkCommand(cmd, { guardrails: DEFAULT_GUARDRAILS }).allowed);
}
check('обычная команда проходит', checkCommand('npm.cmd test', { guardrails: DEFAULT_GUARDRAILS }).allowed);

console.log('\n[4] Таймаут хука останавливает и дочерние процессы');
{
  const hookScript = path.join(dir, 'slow-hook.cjs');
  fs.writeFileSync(hookScript, "require('child_process').spawn('ping', ['-n', '30', '127.0.0.1'], { stdio: 'inherit' }); setTimeout(() => {}, 60000);", 'utf8');
  const hooks = createHookRunner({ hooks: normalizeHooks({ Stop: [{ hooks: [{ command: `"${process.execPath}" "${hookScript}"`, timeout: 2 }] }] }), projectDir: dir });
  const started = Date.now();
  const result = await hooks.run('Stop', {});
  check('хук прерван по таймауту', result.decision === null && Date.now() - started < 10000, `${Date.now() - started} мс`);
  await new Promise((r) => setTimeout(r, 1500));
  const left = execSync('tasklist /FI "IMAGENAME eq PING.EXE" /NH', { encoding: 'utf8' });
  check('дочерний ping хука не остался', !/PING\.EXE/i.test(left), left.trim());
}

try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* Windows держит файл, если процесс ещё не освободил его */
}
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
