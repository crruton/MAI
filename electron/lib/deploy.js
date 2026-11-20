import { spawn } from 'node:child_process';
import { createOutputDecoder, withUtf8Console } from './encoding.js';

const MAX_LOG = 200_000;

function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    /* уже завершился */
  }
}

/**
 * Запускает стадию деплоя как обычную shell-команду.
 * Возвращает handle с kill().
 */
export function runStage({ projectDir, command, onData, onExit }) {
  if (!command) {
    onExit({ code: -1, error: 'Команда стадии не задана' });
    return { kill() {} };
  }

  // Консоль в UTF-8 и перекодировка вывода из кодировки консоли (Windows).
  const decode = createOutputDecoder();
  const child = spawn(withUtf8Console(command), {
    cwd: projectDir,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
  });

  let log = '';
  let finished = false;
  const push = (chunk) => {
    const text = decode(chunk);
    log += text;
    if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
    onData(text);
  };

  child.stdout.on('data', push);
  child.stderr.on('data', push);

  const finish = (code, error = '') => {
    if (finished) return;
    finished = true;
    onExit({ code, error, log });
  };

  child.on('close', (code) => finish(code ?? 0));
  child.on('error', (err) => finish(-1, err.message));

  return {
    kill() {
      if (finished) return;
      push('\n[остановлено пользователем]\n');
      killTree(child);
    },
  };
}
