/**
 * Кроссплатформенные процессы (F26, ADR 0096): выбор оболочки, запуск и
 * остановка дерева процессов.
 */
import { spawn } from 'node:child_process';
import { shellFor, shellLabel, spawnShell, killTree, SHELLS } from '../electron/lib/proc.js';

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
const yes = () => true;
const no = () => false;

console.log('[1] выбор оболочки');
let p = shellFor('dir', { platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } });
check('Windows auto — cmd.exe /d /s /c "…", дословно, UTF-8', p.name === 'cmd' && p.file.endsWith('cmd.exe') && p.args.join(' ') === '/d /s /c "dir"' && p.verbatim && p.utf8Console);
p = shellFor('ls', { platform: 'darwin', env: { SHELL: '/bin/zsh' }, exists: yes });
check('macOS auto — $SHELL zsh -c', p.name === 'zsh' && p.file === '/bin/zsh' && p.args.join(' ') === '-c ls');
p = shellFor('ls', { platform: 'linux', env: { SHELL: '/usr/bin/fish' }, exists: yes });
check('Linux с fish — sh (синтаксис fish не POSIX)', p.name === 'sh' && p.file === '/bin/sh');
p = shellFor('ls', { platform: 'linux', env: { SHELL: '/bin/bash' }, exists: no });
check('$SHELL не существует — sh', p.name === 'sh');
p = shellFor('Get-ChildItem', { shell: 'powershell', platform: 'win32', env: {} });
check('PowerShell: -NoProfile -NonInteractive и вывод UTF-8', p.file === 'powershell.exe' && p.args.slice(0, 3).join(' ') === '-NoProfile -NonInteractive -Command' && /OutputEncoding.*Get-ChildItem$/.test(p.args[3]));
check('powershell на macOS → pwsh', shellFor('x', { shell: 'powershell', platform: 'darwin', env: {} }).file === 'pwsh');
check('cmd вне Windows → sh', shellFor('x', { shell: 'cmd', platform: 'linux', env: {} }).name === 'sh');
check('неизвестная → auto', shellFor('x', { shell: 'fish', platform: 'win32', env: {} }).name === 'cmd');
check('подписи', shellLabel({ shell: 'auto', platform: 'win32', env: {} }) === 'cmd.exe' && shellLabel({ shell: 'pwsh' }) === 'PowerShell 7' && SHELLS.includes('bash'));

console.log('[2] остановка дерева (поддельные вызовы)');
const calls = [];
killTree({ pid: 42, kill: () => calls.push('child') }, { platform: 'win32', run: (cmd, args) => (calls.push(`${cmd} ${args.join(' ')}`), { on() {} }) });
check('Windows — taskkill /pid /T /F', calls[0] === 'taskkill /pid 42 /T /F', calls.join());
calls.length = 0;
killTree({ pid: 42, kill: (s) => calls.push(`child ${s}`) }, { platform: 'linux', graceMs: 0, kill: (pid, s) => calls.push(`group ${pid} ${s}`) });
check('Linux — сигнал группе -pid', calls[0] === 'group -42 SIGTERM', calls.join());
calls.length = 0;
killTree({ pid: 42, kill: (s) => calls.push(`child ${s}`) }, { platform: 'darwin', graceMs: 0, kill: () => { throw new Error('ESRCH'); } });
check('нет группы — сигнал самому процессу', calls[0] === 'child SIGTERM', calls.join());
check('без pid — false', killTree({}) === false);

if (process.platform !== 'win32') {
  console.log('[3] по-настоящему: команда с потомком');
  const child = spawnShell('sleep 30 & sleep 30; echo never', { shell: 'sh' });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await new Promise((r) => setTimeout(r, 300));
  const grandchildren = () => {
    // Живые процессы группы: зомби (Z) не считаем — их не собирает PID 1 контейнера.
    // `ps -A -o pgid=,stat=` — одинаково в Linux и macOS (там `-g` значит другое).
    const ps = spawn('ps', ['-A', '-o', 'pgid=,stat=']);
    return new Promise((r) => {
      let s = '';
      ps.stdout.on('data', (d) => (s += d));
      ps.on('close', () => r(s.split('\n').map((l) => l.trim().split(/\s+/)).filter(([g, st]) => g === String(child.pid) && st && !st.startsWith('Z')).length));
      ps.on('error', () => r(-1));
    });
  };
  const before = await grandchildren();
  killTree(child, { graceMs: 500 });
  const code = await new Promise((r) => child.on('exit', (c, s) => r(s || c)));
  await new Promise((r) => setTimeout(r, 700));
  const after = await grandchildren();
  check('в группе процессов больше одного (sh + sleep)', before >= 2, before);
  check('остановлено сигналом, потомков не осталось', code === 'SIGTERM' && after === 0 && !/never/.test(out), `${code} ${after}`);
  const echo = spawnShell('printf "%s" "$0"', { shell: 'sh' });
  let o2 = '';
  echo.stdout.on('data', (d) => (o2 += d));
  await new Promise((r) => echo.on('close', r));
  check('sh: команда выполняется в /bin/sh', /sh$/.test(o2), o2);
} else {
  console.log('[3] по-настоящему: cmd.exe');
  const child = spawnShell('echo привет & ping -n 30 127.0.0.1 >nul', { wrapCmd: (c) => `chcp 65001 >nul & cmd /d /s /c "${c}"` });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await new Promise((r) => setTimeout(r, 1500));
  killTree(child);
  await new Promise((r) => child.on('exit', r));
  check('cmd.exe: вывод в UTF-8 и остановка дерева', /привет/.test(out), out);
}

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
