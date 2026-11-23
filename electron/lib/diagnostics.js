/**
 * Диагностика кода (CC1.11, ADR 0079): ошибки компилятора и линтера проекта.
 * Вместо постоянного языкового сервера — программы, которые уже стоят в
 * проекте: TypeScript (`tsc --noEmit`), ESLint, Ruff или Pyright; без них —
 * проверка синтаксиса (`node --check`, `python -m py_compile`).
 * Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const TIMEOUT_MS = 120_000;
const MAX_ITEMS = 200;
const JS_EXT = /\.(c|m)?(j|t)sx?$/i;
const TS_EXT = /\.(c|m)?tsx?$/i;
const PY_EXT = /\.pyi?$/i;

const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

/** Программа из node_modules/.bin проекта или ''. */
function localBin(projectDir, name) {
  const file = path.join(projectDir, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  return exists(file) ? file : '';
}

/** Программа в PATH или ''. */
function onPath(name) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  return probe.status === 0 ? String(probe.stdout).split(/\r?\n/)[0].trim() : '';
}

const quote = (arg) => (/[\s"&|<>^]/.test(arg) ? `"${String(arg).replace(/"/g, '\\"')}"` : arg);

function run(cmd, args, cwd, { timeoutMs = TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    // .cmd на Windows запускается только через оболочку.
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    const child = spawn(shell ? quote(cmd) : cmd, shell ? args.map(quote) : args, { cwd, shell, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, out, err });
    });
  });
}

/** Какие проверки доступны в проекте. */
export function detectCheckers(projectDir) {
  const has = (...names) => names.some((n) => exists(path.join(projectDir, n)));
  const list = [];
  const tsc = localBin(projectDir, 'tsc');
  if (tsc && has('tsconfig.json')) list.push({ id: 'tsc', match: TS_EXT, cmd: tsc, project: true });
  const eslint = localBin(projectDir, 'eslint');
  if (eslint && has('eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml')) {
    list.push({ id: 'eslint', match: JS_EXT, cmd: eslint });
  }
  const ruff = onPath('ruff');
  const pyright = ruff ? '' : localBin(projectDir, 'pyright') || onPath('pyright');
  if (ruff) list.push({ id: 'ruff', match: PY_EXT, cmd: ruff });
  else if (pyright) list.push({ id: 'pyright', match: PY_EXT, cmd: pyright });
  return list;
}

/* ---------- разбор вывода ---------- */

export function parseTsc(text, projectDir) {
  const items = [];
  const re = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/gm;
  let m;
  while ((m = re.exec(text))) items.push({ file: path.resolve(projectDir, m[1]), line: +m[2], col: +m[3], severity: m[4], source: `tsc ${m[5]}`, message: m[6].trim() });
  return items;
}

export function parseEslint(json) {
  const items = [];
  for (const f of Array.isArray(json) ? json : []) {
    for (const msg of f.messages || []) {
      items.push({ file: f.filePath, line: msg.line || 1, col: msg.column || 1, severity: msg.severity === 2 ? 'error' : 'warning', source: `eslint ${msg.ruleId || ''}`.trim(), message: msg.message });
    }
  }
  return items;
}

export function parseRuff(json) {
  return (Array.isArray(json) ? json : []).map((d) => ({ file: d.filename, line: d.location?.row || 1, col: d.location?.column || 1, severity: 'error', source: `ruff ${d.code || ''}`.trim(), message: d.message }));
}

export function parsePyright(json) {
  return (json?.generalDiagnostics || []).map((d) => ({ file: d.file, line: (d.range?.start?.line ?? 0) + 1, col: (d.range?.start?.character ?? 0) + 1, severity: d.severity === 'error' ? 'error' : 'warning', source: `pyright ${d.rule || ''}`.trim(), message: d.message }));
}

/** `node --check`: «файл:строка» и сообщение SyntaxError. */
export function parseNodeCheck(text, file) {
  const at = new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(text);
  const msg = /^(SyntaxError: .+)$/m.exec(text);
  return msg ? [{ file, line: at ? +at[1] : 1, col: 1, severity: 'error', source: 'node --check', message: msg[1] }] : [];
}

export function parsePyCompile(text, file) {
  const line = /line (\d+)/.exec(text);
  const msg = /^(\w*Error: .+)$/m.exec(text);
  return msg ? [{ file, line: line ? +line[1] : 1, col: 1, severity: 'error', source: 'py_compile', message: msg[1] }] : [];
}

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Диагностика файла или всего проекта.
 * @returns {Promise<{ items: Array, checkers: string[], note?: string }>}
 */
export async function runDiagnostics(projectDir, { file = '', signal, timeoutMs = TIMEOUT_MS } = {}) {
  const target = file ? path.resolve(projectDir, file) : '';
  const checkers = detectCheckers(projectDir).filter((c) => !target || c.match.test(target));
  const items = [];
  const used = [];
  for (const c of checkers) {
    used.push(c.id);
    if (c.id === 'tsc') {
      const r = await run(c.cmd, ['--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'], projectDir, { timeoutMs, signal });
      const all = parseTsc(`${r.out}\n${r.err}`, projectDir);
      items.push(...(target ? all.filter((i) => i.file === target) : all));
    } else if (c.id === 'eslint') {
      const r = await run(c.cmd, ['-f', 'json', target || '.'], projectDir, { timeoutMs, signal });
      items.push(...parseEslint(json(r.out)));
    } else if (c.id === 'ruff') {
      const r = await run(c.cmd, ['check', '--output-format', 'json', '--quiet', target || '.'], projectDir, { timeoutMs, signal });
      items.push(...parseRuff(json(r.out)));
    } else if (c.id === 'pyright') {
      const r = await run(c.cmd, ['--outputjson', ...(target ? [target] : [])], projectDir, { timeoutMs, signal });
      items.push(...parsePyright(json(r.out)));
    }
  }
  // Нет программ проекта — хотя бы синтаксис файла.
  if (target && !used.length) {
    if (/\.(c|m)?js$/i.test(target)) {
      const r = await run(process.execPath, ['--check', target], projectDir, { timeoutMs, signal });
      used.push('node --check');
      items.push(...parseNodeCheck(`${r.err}\n${r.out}`, target));
    } else if (PY_EXT.test(target)) {
      const python = onPath('python3') || onPath('python');
      if (python) {
        const r = await run(python, ['-m', 'py_compile', target], projectDir, { timeoutMs, signal });
        used.push('py_compile');
        items.push(...parsePyCompile(`${r.err}\n${r.out}`, target));
      }
    }
  }
  return { items, checkers: used, ...(used.length ? {} : { note: 'проверок для этого файла нет: нужен tsc с tsconfig.json, eslint с конфигом, ruff или pyright' }) };
}

/** Диагностика текстом для модели: файл:строка:колонка, важность, источник. */
export function formatDiagnostics(result, projectDir) {
  if (!result.checkers.length) return `Диагностика недоступна: ${result.note}`;
  const errors = result.items.filter((i) => i.severity === 'error').length;
  if (!result.items.length) return `Ошибок нет (${result.checkers.join(', ')}).`;
  const rel = (f) => (projectDir ? path.relative(projectDir, f) || f : f).split(path.sep).join('/');
  const lines = result.items.slice(0, MAX_ITEMS).map((i) => `${rel(i.file)}:${i.line}:${i.col} ${i.severity === 'error' ? 'ошибка' : 'предупреждение'} [${i.source}] ${i.message}`);
  const more = result.items.length > MAX_ITEMS ? `\n… ещё ${result.items.length - MAX_ITEMS}` : '';
  return `Ошибок: ${errors}, предупреждений: ${result.items.length - errors} (${result.checkers.join(', ')})\n${lines.join('\n')}${more}`;
}
