import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { checkCommand } from '../guardrails.js';
import { createOutputDecoder, withUtf8Console } from '../encoding.js';
import { sandboxPlan, dockerRunArgs } from '../shell-sandbox.js';
import { normalizeRoots, resolveIn } from '../workroots.js';

const MAX_OUTPUT = 200_000; // дальше — единый лимит runToolCall: остальное в файл (CC1.13)
const TIMEOUT_MS = 180_000;

// repowise может быть не установлен. Проверяем один раз и кешируем результат,
// иначе каждая команда получает префикс и падает с «не является внутренней командой».
let repowiseAvailable = null;

function hasRepowise() {
  if (repowiseAvailable !== null) return repowiseAvailable;
  try {
    // Аргументы не передаём массивом: с shell: true Node выдаёт DEP0190.
    const probe = spawnSync('repowise --version', {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      shell: true,
    });
    repowiseAvailable = probe.status === 0;
  } catch {
    repowiseAvailable = false;
  }
  return repowiseAvailable;
}

/**
 * Команда, которая реально выполнится. Repowise distill оборачивает простые
 * команды, и пользователь должен подтверждать именно итоговую строку (ADR 0027).
 */
export function effectiveCommand(ctx, args) {
  const command = String(args?.command || '');
  if (ctx?.repowise?.distill && command && !/^\s*repowise\b/.test(command) && !/[|&<>]/.test(command) && hasRepowise()) {
    return `repowise distill ${command}`;
  }
  return command;
}

/** Рабочая папка команды: всегда внутри проекта, если не включён доступ вне проекта. */
export function resolveCwd(ctx, cwd) {
  // Рабочая папка — в проекте или в добавленной папке чата (`@имя/…`, ADR 0045).
  const roots = ctx?.roots || normalizeRoots(ctx?.projectDir || process.cwd());
  try {
    return resolveIn(roots, cwd || '.', { allowOutside: Boolean(ctx?.allowOutsideProject) });
  } catch (err) {
    throw new Error(`Рабочая папка: ${err.message}`);
  }
}

export const shellTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'run_shell',
        description:
          'Выполнить команду в папке проекта (cmd.exe на Windows). Подтверждение зависит от режима разрешений. Возвращает stdout, stderr и код возврата.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Команда целиком' },
            cwd: { type: 'string', description: 'Рабочая папка относительно проекта' },
          },
          required: ['command'],
        },
      },
    },
    async run(ctx, args) {
      // Разрешение уже получено в цикле агента (PolicyEngine). Guardrails
      // проверяются ещё раз — защита в глубину для прямых вызовов.
      const check = checkCommand(args.command, { guardrails: ctx.guardrails });
      if (!check.allowed) {
        return `Guardrails заблокировали команду: ${check.reason}`;
      }
      const cwd = resolveCwd(ctx, args.cwd);
      const command = effectiveCommand(ctx, args);
      // Песочница для команд (ADR 0040): docker, хост по списку или отказ, если Docker недоступен.
      const plan = sandboxPlan(command, ctx.shellSandbox, { dockerAvailable: Boolean(ctx.dockerAvailable?.()) });
      if (plan.where === 'blocked') return `$ ${command}\n\n${plan.why}`;
      const container =
        plan.where === 'docker'
          ? {
              name: `mai-shell-${process.pid}-${Date.now().toString(36)}`,
              label: plan.why,
              build: (name) =>
                dockerRunArgs({
                  command,
                  projectDir: ctx.projectDir || cwd,
                  cwd,
                  config: ctx.shellSandbox,
                  roots: ctx.roots,
                  name,
                  uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
                  gid: typeof process.getgid === 'function' ? process.getgid() : undefined,
                }),
            }
          : null;
      return await execute(command, cwd, { onData: ctx.progress, signal: ctx.signal, container });
    },
  },
];

/** Останавливает команду вместе с дочерними процессами (npm → node → …). */
function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else if (child.pid) {
      // Команда запущена в своей группе процессов: минус pid останавливает всю группу.
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* процесс уже завершён */
    }
  }
}

/**
 * Выполняет команду оболочки.
 * @param {object} [options]
 * @param {(text: string) => void} [options.onData] живой вывод для карточки (CC7.4)
 * @param {AbortSignal} [options.signal] «Стоп» останавливает процесс, а не только ожидание
 */
export function execute(command, cwd, { onData, signal, container = null } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (signal?.aborted) {
      resolve(`$ ${command}\n\n[остановлено до запуска]`);
      return;
    }
    // На Windows консоль переводится в UTF-8, а вывод в кодировке консоли перекодируется.
    const decode = createOutputDecoder();
    // В контейнере — `docker run` без оболочки хоста; остановка — `docker kill`.
    const child = container
      ? spawn('docker', container.build(container.name), { cwd, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' } })
      : spawn(withUtf8Console(command), {
          cwd,
          shell: true,
          windowsHide: true,
          detached: process.platform !== 'win32',
          env: { ...process.env, FORCE_COLOR: '0' },
        });
    if (container) child.stdin?.end();
    let out = '';
    let stopped = '';
    const stop = (reason) => {
      if (stopped) return;
      stopped = reason;
      if (container) {
        try {
          spawn('docker', ['kill', container.name], { windowsHide: true }).on('error', () => {});
        } catch {
          /* контейнер уже завершён */
        }
      }
      killTree(child);
    };
    const timer = setTimeout(() => stop(`таймаут ${TIMEOUT_MS / 1000} с — процесс остановлен`), TIMEOUT_MS);
    const onAbort = () => stop('остановлено пользователем');
    signal?.addEventListener('abort', onAbort, { once: true });
    const push = (d) => {
      const text = decode(d);
      out += text;
      try {
        onData?.(text);
      } catch {
        /* окно закрыто — вывод всё равно копится */
      }
      if (out.length > MAX_OUTPUT * 2) stop('вывод слишком большой — процесс остановлен');
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const trimmed = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n… обрезано` : out;
      const note = stopped ? `\n[${stopped}]` : '';
      const where = container ? ` · ${container.label}` : '';
      resolve(`$ ${command}\n\n${trimmed || '(нет вывода)'}${note}\n\n[код ${code}, ${Date.now() - started} мс${where}]`);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(`Ошибка запуска: ${err.message}`);
    });
  });
}
