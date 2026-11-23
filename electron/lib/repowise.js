import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Repowise — локальный индекс кода с MCP-сервером.
 * Мы не встраиваем его внутрь: вызываем CLI и подключаем MCP.
 * Документация: https://docs.repowise.dev
 */

const MAX_OUTPUT = 120_000;

function winQuote(value) {
  const text = String(value ?? '');
  if (!text) return '""';
  if (!/[\s"&|<>^()]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * uv/pipx кладут исполняемый файл в ~/.local/bin, который не всегда есть в PATH
 * у GUI-приложения. Ищем бинарь явно, иначе падаем на обычный `repowise`.
 */
function binary() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    path.join(home, '.local', 'bin', 'repowise.exe'),
    path.join(home, '.local', 'bin', 'repowise'),
    path.join(home, 'AppData', 'Roaming', 'Python', 'Scripts', 'repowise.exe'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* пробуем следующий */
    }
  }
  return 'repowise';
}

const rw = () => winQuote(binary());

function run(command, cwd, timeout = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
    });
    let out = '';
    let finished = false;
    const push = (chunk) => {
      out += chunk.toString();
      if (out.length > MAX_OUTPUT) out = out.slice(-MAX_OUTPUT);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => {
      push(`\n[таймаут ${Math.round(timeout / 1000)} с]`);
      child.kill();
    }, timeout);
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out.trim() });
    });
    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, output: err.message });
    });
  });
}

export async function detect() {
  const res = await run(`${rw()} --version`, process.cwd(), 15_000);
  return {
    installed: res.ok,
    version: res.ok ? res.output.split(/\r?\n/)[0] : '',
    error: res.ok ? '' : res.output.slice(0, 300),
  };
}

export async function status(projectDir) {
  const info = await detect();
  const indexPath = path.join(projectDir, '.repowise');
  return {
    ...info,
    indexed: fs.existsSync(indexPath),
    indexPath,
    projectDir,
  };
}

export async function install() {
  const uv = await run('uv tool install repowise', process.cwd(), 15 * 60 * 1000);
  if (uv.ok) return { ok: true, via: 'uv', output: uv.output };
  const pipx = await run('pipx install repowise', process.cwd(), 15 * 60 * 1000);
  if (pipx.ok) return { ok: true, via: 'pipx', output: pipx.output };
  return { ok: false, output: `${uv.output}\n\n${pipx.output}`.trim() };
}

export async function init(projectDir, { editorSetup = false } = {}) {
  // По умолчанию не трогаем глобальные конфиги редакторов и git-хуки:
  // MAI Code подключает MCP сам, а чужие настройки менять не должен.
  const flags = ['--yes', '--no-prose'];
  if (!editorSetup) flags.push('--no-editor-setup');
  const command = `${rw()} init ${winQuote(projectDir)} ${flags.join(' ')}`;
  const res = await run(command, projectDir, 20 * 60 * 1000);
  return { ...res, command: `repowise init ${flags.join(' ')}` };
}

export async function update(projectDir) {
  return run(`${rw()} update ${winQuote(projectDir)}`, projectDir, 20 * 60 * 1000);
}

export async function ask(projectDir, question) {
  return run(`${rw()} ask ${winQuote(question)}`, projectDir, 5 * 60 * 1000);
}

export async function search(projectDir, query) {
  return run(`${rw()} search ${winQuote(query)}`, projectDir, 3 * 60 * 1000);
}

export async function context(projectDir, files) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean).map(winQuote).join(' ');
  return run(`${rw()} context ${list}`, projectDir, 3 * 60 * 1000);
}

export async function risk(projectDir, range = 'main..HEAD') {
  return run(`${rw()} risk ${winQuote(range)}`, projectDir, 5 * 60 * 1000);
}

export async function doctor(projectDir) {
  return run(`${rw()} doctor`, projectDir, 2 * 60 * 1000);
}

/** Сжимает вывод команды, сохраняя строки ошибок. */
export async function distill(projectDir, command) {
  if (!command) return { ok: false, output: 'Пустая команда' };
  return run(`${rw()} distill ${command}`, projectDir, 10 * 60 * 1000);
}

/** MCP-конфиг для менеджера MCP: сервер запускается в папке проекта. */
export function mcpConfig(projectDir) {
  return {
    command: binary(),
    args: ['serve', '--no-ui'],
    cwd: projectDir,
    disabled: false,
    // F13 (ADR 0088): `serve --no-ui` иногда зависает — запрос ждёт 60 с, затем
    // процесс перезапускается и запрос повторяется (инструменты индекса только читают).
    callTimeoutMs: 60_000,
    restartOnTimeout: true,
    retryOnTimeout: true,
  };
}

const dashboards = new Map(); // projectDir -> child

/** Запускает локальный дашборд (если ещё не запущен) и возвращает URL. */
export async function serve(projectDir) {
  const existing = dashboards.get(projectDir);
  if (existing && !existing.killed) return { ok: true, started: false, url: 'http://127.0.0.1:8765' };

  const child = spawn(`${rw()} serve ${winQuote(projectDir)}`, {
    cwd: projectDir,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  dashboards.set(projectDir, child);

  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));

  await new Promise((resolve) => setTimeout(resolve, 4000));
  const match = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/.exec(output);
  return {
    ok: true,
    started: true,
    url: match?.[0] || 'http://127.0.0.1:8765',
    output: output.slice(0, 1200),
  };
}

export function stopServe(projectDir) {
  const child = dashboards.get(projectDir);
  if (child) {
    try {
      child.kill();
    } catch {
      /* уже остановлен */
    }
    dashboards.delete(projectDir);
  }
  return true;
}

export function stopAll() {
  for (const child of dashboards.values()) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  dashboards.clear();
}
