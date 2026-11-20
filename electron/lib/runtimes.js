import { spawn, spawnSync } from 'node:child_process';
import { createOutputDecoder } from './encoding.js';

const MAX_OUTPUT = 300_000;
const TIMEOUT_MS = 30 * 60 * 1000;
const FORWARD_ENV = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MAI_API_KEY', 'GEMINI_API_KEY'];

/* ---------- запуск без оболочки (ADR 0029, бэклог A4.2) ---------- */

// Экранирование для cmd.exe — как в cross-spawn: кавычки по правилам MSVCRT,
// затем каждый метасимвол cmd через ^. Для npm-обёрток в node_modules/.bin
// экранирование двойное: обёртка ещё раз разбирает %*.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

export function escapeCmdCommand(command) {
  return String(command).replace(CMD_META, '^$1');
}

export function escapeCmdArgument(value, doubleEscape = false) {
  let arg = String(value ?? '');
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  arg = arg.replace(/(?=(\\+?)?)\1$/, '$1$1');
  arg = `"${arg}"`;
  arg = arg.replace(CMD_META, '^$1');
  if (doubleEscape) arg = arg.replace(CMD_META, '^$1');
  return arg;
}

function resolveWindowsCommand(command) {
  if (/[\\/]/.test(command) && /\.[a-z0-9]+$/i.test(command)) return command;
  const probe = spawnSync('where', [command], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  const found = String(probe.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return found.find((line) => /\.(exe|com)$/i.test(line)) || found.find((line) => /\.(cmd|bat)$/i.test(line)) || command;
}

/**
 * Как запустить процесс, не отдавая запрос пользователя в разбор оболочке.
 * - POSIX и .exe на Windows: spawn без shell, аргументы массивом — переводы
 *   строк, %VAR%, кавычки и & передаются как есть;
 * - .cmd/.bat на Windows: cmd.exe /d /s /c с экранированием каждого аргумента.
 *   Перевод строки через cmd передать нельзя — его заменяем пробелом и
 *   сообщаем об этом (`flattened`).
 */
export function spawnPlan(command, args, { platform = process.platform, resolve = resolveWindowsCommand } = {}) {
  if (platform !== 'win32') return { file: command, args, options: {}, flattened: false };
  const resolved = resolve(command);
  if (/\.(exe|com)$/i.test(resolved)) return { file: resolved, args, options: {}, flattened: false };
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  let flattened = false;
  const safeArgs = args.map((arg) => {
    const text = String(arg ?? '');
    if (/\r|\n/.test(text)) flattened = true;
    return escapeCmdArgument(text.replace(/\r?\n/g, ' '), doubleEscape);
  });
  const line = [escapeCmdCommand(resolved), ...safeArgs].join(' ');
  return {
    file: process.env.comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
    flattened,
    shim: true,
  };
}

/* ---------- режим разрешений для CLI (ADR 0029, бэклог A4.1) ---------- */

const READ_ONLY_MODES = new Set(['plan', 'manual', 'dontAsk']);

/** Поле пресета, если сохранённый рантайм — тот же CLI (команда не менялась). */
function presetField(runtime, field) {
  if (runtime?.[field] !== undefined) return runtime[field];
  const preset = Object.values(RUNTIME_PRESETS).find((p) => p.command && p.command === runtime?.command);
  return preset?.[field];
}

/**
 * Как CLI выполнит режим разрешений. Внешний агент нельзя спросить посреди
 * работы, поэтому «Вручную» и «Только разрешённое» для него значат «без
 * действий, требующих подтверждения».
 * - docker: «План», «Вручную», «Только разрешённое» — проект монтируется только на чтение;
 * - host: флаги CLI из `permissionArgs`; если флагов для режима нет — отказ,
 *   кроме «Без вопросов» (CLI работает по своим настройкам).
 */
export function permissionPlan(runtime, mode = 'manual') {
  if (runtime?.mode === 'docker') {
    return { ok: true, args: [], readOnly: READ_ONLY_MODES.has(mode), how: READ_ONLY_MODES.has(mode) ? 'docker: проект только на чтение' : 'docker' };
  }
  const map = presetField(runtime, 'permissionArgs') || {};
  if (Array.isArray(map[mode])) return { ok: true, args: map[mode], readOnly: false, how: map[mode].join(' ') || 'по умолчанию CLI' };
  if (mode === 'bypass') return { ok: true, args: [], readOnly: false, how: 'настройки самого CLI' };
  const name = runtime?.name || runtime?.command || 'Рантайм';
  return {
    ok: false,
    error:
      `${name} не умеет соблюдать текущий режим разрешений из командной строки. ` +
      'Запустите рантайм в режиме docker (проект смонтируется только на чтение), ' +
      'задайте флаги в поле permissionArgs или переключите чат в режим «Без вопросов».',
  };
}

function applyTemplate(template, vars) {
  return String(template).replace(/\{(prompt|model|projectDir|target)\}/g, (_m, key) => vars[key] ?? '');
}

/** Собирает команду рантайма с подстановкой {prompt}, {model}, {projectDir}, {target}. */
export function buildCommand(runtime, vars, { modeArgs = [], stdin = false } = {}) {
  const template = runtime.args || [];
  const stdinSpec = presetField(runtime, 'stdin') || {};
  let args = [];
  for (const arg of template) {
    if (stdin && String(arg) === '{prompt}') {
      // Запрос уйдёт через stdin; часть CLI ждут на этом месте «-».
      if (stdinSpec.arg) args.push(stdinSpec.arg);
      continue;
    }
    args.push(applyTemplate(arg, vars));
  }
  const hasPrompt = template.some((arg) => String(arg).includes('{prompt}'));
  if (!hasPrompt && !stdin) args.push(vars.prompt);
  if (modeArgs.length) {
    const at = Math.max(0, Math.min(args.length, Number(presetField(runtime, 'permissionArgsAt') ?? 0)));
    args = [...args.slice(0, at), ...modeArgs, ...args.slice(at)];
  }
  return { command: runtime.command, args };
}

/** Можно ли передать запрос через stdin: пресет это объявил, и {prompt} — отдельный аргумент. */
export function supportsStdin(runtime) {
  return Boolean(presetField(runtime, 'stdin')) && (runtime.args || []).some((arg) => String(arg) === '{prompt}');
}

export function describeRuntime(runtime, vars, permissionMode = '') {
  const plan = permissionMode ? permissionPlan(runtime, permissionMode) : { ok: true, args: [], readOnly: false };
  const extra = plan.ok ? { modeArgs: plan.args, readOnly: plan.readOnly } : {};
  const { command, args } = runtime.mode === 'docker'
    ? buildDockerCommand(runtime, vars, vars.projectDir, extra)
    : buildCommand(runtime, vars, extra);
  return [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
}

/** Собирает `docker run` для рантайма, который должен жить в контейнере. */
export function buildDockerCommand(runtime, vars, projectDir, { readOnly = false, modeArgs = [], stdin = false } = {}) {
  const image = String(runtime.image || '').trim();
  if (!image) throw new Error('Для режима docker укажите образ (image)');
  const inner = buildCommand(runtime, vars, { modeArgs, stdin });
  const args = [
    'run',
    '--rm',
    '--init',
    '--network',
    runtime.network || 'bridge',
    '--memory',
    runtime.memory || '2g',
    '--cpus',
    runtime.cpus || '2',
    '--pids-limit',
    '512',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,size=256m',
    '--volume',
    readOnly ? `${projectDir}:/workspace:ro` : `${projectDir}:/workspace`,
    '--workdir',
    '/workspace',
  ];
  for (const name of runtime.forwardEnv || FORWARD_ENV) {
    if (process.env[name]) args.push('--env', name);
  }
  if (stdin) args.splice(1, 0, '--interactive');
  args.push(image, inner.command, ...inner.args);
  return { command: 'docker', args };
}

/** Проверяет, доступна ли команда рантайма (и образ для docker-режима). */
export function probeRuntime(runtime) {
  const command = String(runtime?.command || '').trim();
  if (runtime?.mode === 'docker') {
    const image = String(runtime.image || '').trim();
    if (!image) return { available: false, error: 'Не задан образ для docker-режима' };
    const docker = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    });
    if (docker.error) return { available: false, error: docker.error.message };
    if (docker.status !== 0) {
      return { available: false, error: `Образ ${image} не найден локально. Выполните: docker pull ${image}` };
    }
    return { available: true, path: `docker:${image}`, version: String(docker.stdout || '').trim().slice(0, 19) };
  }
  if (!command) return { available: false, error: 'Команда не задана' };
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
    encoding: 'utf8',
    timeout: 10_000,
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  const pathLine = String(probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  if (probe.error) return { available: false, error: probe.error.message };
  if (probe.status !== 0 || !pathLine) {
    return { available: false, error: `CLI «${command}» не найден в PATH` };
  }
  return { available: true, path: pathLine, version: '' };
}

/** OpenCode в неинтерактивном режиме печатает JSON-события — вытаскиваем текст. */
function opencodeParser() {
  let buffer = '';
  const parts = new Map();
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    let out = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        out += `${line}\n`;
        continue;
      }
      if (event.type === 'text' && event.part?.text) {
        const id = event.part.id || 'default';
        const previous = parts.get(id) || '';
        const text = event.part.text;
        if (text.startsWith(previous)) out += text.slice(previous.length);
        else out += `${previous ? '\n' : ''}${text}`;
        parts.set(id, text);
      }
    }
    return out;
  };
}

/**
 * Запускает внешний агент и стримит вывод.
 * Возвращает объект с kill() и promise завершения.
 */
export function startRuntime({ runtime, prompt, model, projectDir, permissionMode = 'manual', onData, onExit, platform = process.platform }) {
  // Режим разрешений обязателен для CLI так же, как для встроенного агента (ADR 0029).
  const permission = permissionPlan(runtime, permissionMode);
  if (!permission.ok) {
    onExit({ code: -1, error: permission.error, permissionDenied: true });
    return { kill() {} };
  }
  const vars = { prompt, model, projectDir, target: runtime.target || '' };
  const build = (stdin) =>
    runtime.mode === 'docker'
      ? buildDockerCommand(runtime, vars, projectDir || process.cwd(), { readOnly: permission.readOnly, modeArgs: permission.args, stdin })
      : buildCommand(runtime, vars, { modeArgs: permission.args, stdin });

  let stdin = runtime.promptVia === 'stdin' && supportsStdin(runtime);
  let spec;
  let plan;
  try {
    spec = build(stdin);
    if (!spec.command) {
      onExit({ code: -1, error: 'Не задана команда рантайма' });
      return { kill() {} };
    }
    plan = spawnPlan(spec.command, spec.args, { platform });
    // Многострочный запрос через cmd.exe не пройдёт — переходим на stdin, если CLI умеет.
    if (plan.flattened && !stdin && supportsStdin(runtime)) {
      stdin = true;
      spec = build(true);
      plan = spawnPlan(spec.command, spec.args, { platform });
    }
  } catch (err) {
    onExit({ code: -1, error: err.message });
    return { kill() {} };
  }

  const child = spawn(plan.file, plan.args, {
    cwd: projectDir || process.cwd(),
    shell: false,
    windowsHide: true,
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
    ...plan.options,
  });
  if (stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  }

  const transform = runtime.parser === 'opencode-json' ? opencodeParser() : null;
  // Вывод CLI на Windows может прийти в кодировке консоли — перекодируем.
  const decode = createOutputDecoder();
  let output = '';
  let finished = false;

  const push = (chunk) => {
    const raw = decode(chunk);
    const text = transform ? transform(raw) : raw;
    if (!text) return;
    output += text;
    if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    onData(text);
  };

  child.stdout.on('data', push);
  child.stderr.on('data', push);
  if (plan.flattened) {
    push('[запрос передан одной строкой: cmd.exe не передаёт переводы строк, а CLI не читает запрос из stdin]\n');
  }

  const timer = setTimeout(() => {
    push(`\n[таймаут ${TIMEOUT_MS / 60000} мин — процесс остановлен]\n`);
    killTree(child);
  }, TIMEOUT_MS);

  const finish = (code, error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    onExit({ code, error: error || '', output });
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

function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    /* процесс уже умер */
  }
}

/** Пресеты для панели «Рантаймы». */
export const RUNTIME_PRESETS = {
  opencode: {
    name: 'OpenCode',
    command: 'opencode',
    args: ['run', '--format', 'json', '{prompt}'],
    promptVia: 'arg',
    parser: 'opencode-json',
    enabled: true,
    mode: 'host',
  },
  herdr: {
    name: 'herdr',
    command: 'herdr',
    args: ['agent', 'prompt', '{target}', '{prompt}', '--wait'],
    promptVia: 'arg',
    target: '',
    enabled: false,
    mode: 'host',
  },
  claude: {
    name: 'Claude Code',
    command: 'claude',
    args: ['-p', '{prompt}'],
    promptVia: 'arg',
    // В режиме -p действия, требующие подтверждения, CLI отклоняет сам.
    permissionArgs: {
      plan: ['--permission-mode', 'plan'],
      manual: ['--permission-mode', 'default'],
      dontAsk: ['--permission-mode', 'default'],
      acceptEdits: ['--permission-mode', 'acceptEdits'],
      bypass: ['--permission-mode', 'bypassPermissions'],
    },
    permissionArgsAt: 0,
    stdin: { arg: '' },
    enabled: false,
    mode: 'host',
  },
  codex: {
    name: 'Codex CLI',
    command: 'codex',
    args: ['exec', '{prompt}'],
    promptVia: 'arg',
    permissionArgs: {
      plan: ['--sandbox', 'read-only'],
      manual: ['--sandbox', 'read-only'],
      dontAsk: ['--sandbox', 'read-only'],
      acceptEdits: ['--sandbox', 'workspace-write'],
      bypass: ['--sandbox', 'danger-full-access'],
    },
    permissionArgsAt: 1,
    // `codex exec -` читает запрос из stdin.
    stdin: { arg: '-' },
    enabled: false,
    mode: 'host',
  },
  gemini: {
    name: 'Gemini CLI',
    command: 'gemini',
    args: ['-p', '{prompt}'],
    promptVia: 'arg',
    // Для «Плана» и «Вручную» у Gemini CLI нет гарантированного флага — только docker.
    permissionArgs: {
      acceptEdits: ['--approval-mode', 'auto_edit'],
      bypass: ['--approval-mode', 'yolo'],
    },
    permissionArgsAt: 0,
    enabled: false,
    mode: 'host',
  },
  dsh: {
    name: 'DeepSeek Harness',
    command: 'dsh',
    args: ['run', '{prompt}'],
    promptVia: 'arg',
    enabled: false,
    mode: 'host',
    note: 'Требует DEEPSEEK_API_KEY и профиль dsh. Команду уточните под версию CLI.',
  },
  hermes: {
    name: 'Hermes',
    command: 'hermes',
    args: ['-p', '{prompt}'],
    promptVia: 'arg',
    enabled: false,
    mode: 'host',
    note: 'Nous Research Hermes CLI. Модель задаётся в конфигурации Hermes.',
  },
  jev: {
    name: 'JEV',
    command: 'jev',
    args: ['{prompt}'],
    promptVia: 'arg',
    enabled: false,
    mode: 'host',
    note: 'Локальный JEV CLI. Проверьте имя команды в своей установке.',
  },
  custom: {
    name: 'Своя команда',
    command: '',
    args: ['{prompt}'],
    promptVia: 'arg',
    enabled: false,
    mode: 'host',
  },
};
