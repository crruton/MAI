import { spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * Кроссплатформенные процессы (F26, ADR 0096): выбор оболочки и остановка
 * дерева процессов — одна реализация для run_shell, хуков, стадий деплоя и рантаймов.
 *
 * Модуль не зависит от Electron.
 */

export const SHELLS = ['auto', 'cmd', 'powershell', 'pwsh', 'bash', 'zsh', 'sh'];

/**
 * Оболочка для команды: { name, file, args, utf8Console }.
 * auto: Windows — cmd.exe; macOS/Linux — $SHELL, если это bash или zsh, иначе /bin/sh.
 */
export function shellFor(command, { shell = 'auto', platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  let name = SHELLS.includes(shell) ? shell : 'auto';
  if (name === 'auto') {
    if (platform === 'win32') name = 'cmd';
    else {
      const login = String(env.SHELL || '');
      name = /\/(bash|zsh)$/.test(login) && exists(login) ? login.split('/').pop() : 'sh';
    }
  }
  if (name === 'cmd') {
    if (platform !== 'win32') name = 'sh';
    // /d — без AutoRun, /s /c — строка как есть; кодировка — chcp 65001 (encoding.js).
    // Как shell: true у Node: cmd.exe /d /s /c "<строка>" с дословными аргументами.
    else return { name, file: env.ComSpec || env.comspec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], utf8Console: true, verbatim: true };
  }
  if (name === 'powershell' || name === 'pwsh') {
    const file = name === 'powershell' && platform !== 'win32' ? 'pwsh' : name === 'powershell' ? 'powershell.exe' : 'pwsh';
    // UTF-8 вывода задаём в самой команде: иначе кириллица в pipe — в кодировке консоли.
    const prefix = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ';
    return { name, file, args: ['-NoProfile', '-NonInteractive', '-Command', `${prefix}${command}`], utf8Console: false };
  }
  const file = name === 'sh' ? '/bin/sh' : platform === 'win32' ? name : env.SHELL && env.SHELL.endsWith(`/${name}`) ? env.SHELL : name;
  return { name, file, args: ['-c', command], utf8Console: false };
}

/** Описание оболочки для модели и интерфейса: «cmd.exe», «bash», «PowerShell». */
export function shellLabel(opts = {}) {
  const { name } = shellFor('', opts);
  return { cmd: 'cmd.exe', powershell: 'Windows PowerShell', pwsh: 'PowerShell 7', bash: 'bash', zsh: 'zsh', sh: 'sh' }[name] || name;
}

/**
 * Запуск команды в выбранной оболочке. На macOS/Linux — своя группа процессов
 * (detached), чтобы killTree остановил и потомков (npm → node → …).
 */
export function spawnShell(command, { shell = 'auto', cwd, env = process.env, stdio, platform = process.platform, wrapCmd = (c) => c } = {}) {
  let plan = shellFor(command, { shell, platform, env });
  // cmd.exe: консоль в UTF-8 (chcp 65001) — обёртка из encoding.js.
  if (plan.utf8Console) plan = shellFor(wrapCmd(command), { shell, platform, env });
  return spawn(plan.file, plan.args, {
    cwd,
    env,
    windowsHide: true,
    detached: platform !== 'win32',
    ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
    ...(stdio ? { stdio } : {}),
  });
}

/**
 * Остановить процесс вместе с потомками. Windows — taskkill /T /F; macOS/Linux —
 * сигнал группе (-pid), если процесс в своей группе, иначе самому процессу; через
 * `graceMs` — SIGKILL тем, кто не вышел.
 */
export function killTree(child, { signal = 'SIGTERM', graceMs = 3000, platform = process.platform, run = spawn, kill = process.kill.bind(process) } = {}) {
  if (!child?.pid) return false;
  if (platform === 'win32') {
    try {
      run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on?.('error', () => {});
      return true;
    } catch {
      /* ниже — child.kill */
    }
  }
  const send = (sig) => {
    try {
      kill(-child.pid, sig);
      return true;
    } catch {
      try {
        child.kill(sig);
        return true;
      } catch {
        return false;
      }
    }
  };
  const sent = send(signal);
  if (sent && signal !== 'SIGKILL' && graceMs > 0) {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) send('SIGKILL');
    }, graceMs);
    timer.unref?.();
  }
  return sent;
}
