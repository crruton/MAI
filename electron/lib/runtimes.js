import { spawn } from 'node:child_process';

const MAX_OUTPUT = 300_000;
const TIMEOUT_MS = 30 * 60 * 1000;

function winQuote(value) {
  const text = String(value ?? '');
  if (!text) return '""';
  if (!/[\s"&|<>^()]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function applyTemplate(template, vars) {
  return String(template).replace(/\{(prompt|model|projectDir|target)\}/g, (_m, key) => vars[key] ?? '');
}

/** Собирает команду рантайма с подстановкой {prompt}, {model}, {projectDir}, {target}. */
export function buildCommand(runtime, vars) {
  const args = (runtime.args || []).map((arg) => applyTemplate(arg, vars));
  const hasPrompt = (runtime.args || []).some((arg) => String(arg).includes('{prompt}'));
  if (!hasPrompt) args.push(vars.prompt);
  return { command: runtime.command, args };
}

export function describeRuntime(runtime, vars) {
  const { command, args } = buildCommand(runtime, vars);
  return [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
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
export function startRuntime({ runtime, prompt, model, projectDir, onData, onExit }) {
  const { command, args } = buildCommand(runtime, { prompt, model, projectDir, target: runtime.target || '' });

  if (!command) {
    onExit({ code: -1, error: 'Не задана команда рантайма' });
    return { kill() {} };
  }

  const line = [command, ...args].map(winQuote).join(' ');
  const child = spawn(line, {
    cwd: projectDir || process.cwd(),
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
  });

  const transform = runtime.parser === 'opencode-json' ? opencodeParser() : null;
  let output = '';
  let finished = false;

  const push = (chunk) => {
    const text = transform ? transform(chunk.toString()) : chunk.toString();
    if (!text) return;
    output += text;
    if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    onData(text);
  };

  child.stdout.on('data', push);
  child.stderr.on('data', push);

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
  },
  herdr: {
    name: 'herdr',
    command: 'herdr',
    args: ['agent', 'prompt', '{target}', '{prompt}', '--wait'],
    promptVia: 'arg',
    target: '',
    enabled: false,
  },
  claude: {
    name: 'Claude Code',
    command: 'claude',
    args: ['-p', '{prompt}'],
    promptVia: 'arg',
    enabled: false,
  },
  codex: {
    name: 'Codex CLI',
    command: 'codex',
    args: ['exec', '{prompt}'],
    promptVia: 'arg',
    enabled: false,
  },
  gemini: {
    name: 'Gemini CLI',
    command: 'gemini',
    args: ['-p', '{prompt}'],
    promptVia: 'arg',
    enabled: false,
  },
  dsh: {
    name: 'DeepSeek Harness',
    command: 'dsh',
    args: ['run', '{prompt}'],
    promptVia: 'arg',
    enabled: false,
    note: 'Требует DEEPSEEK_API_KEY и профиль dsh. Команду уточните под версию CLI.',
  },
  hermes: {
    name: 'Hermes',
    command: 'hermes',
    args: ['-p', '{prompt}'],
    promptVia: 'arg',
    enabled: false,
    note: 'Nous Research Hermes CLI. Модель задаётся в конфигурации Hermes.',
  },
  jev: {
    name: 'JEV',
    command: 'jev',
    args: ['{prompt}'],
    promptVia: 'arg',
    enabled: false,
    note: 'Локальный JEV CLI. Проверьте имя команды в своей установке.',
  },
  custom: {
    name: 'Своя команда',
    command: '',
    args: ['{prompt}'],
    promptVia: 'arg',
    enabled: false,
  },
};
