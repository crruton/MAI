import { spawn, spawnSync } from 'node:child_process';
import { checkCommand } from '../guardrails.js';

const MAX_OUTPUT = 24_000;
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

export const shellTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'run_shell',
        description:
          'Выполнить команду в папке проекта (cmd.exe на Windows). Требует подтверждения пользователя. Возвращает stdout, stderr и код возврата.',
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
      const check = checkCommand(args.command, { guardrails: ctx.guardrails });
      if (!check.allowed) {
        return `Guardrails заблокировали команду: ${check.reason}`;
      }
      const allowed = await ctx.approve('run_shell', args.command);
      if (allowed !== true) return typeof allowed === 'string' ? allowed : 'Пользователь отклонил выполнение команды.';
      let command = String(args.command || '');
      // Repowise distill сжимает вывод тестов/установки/гита, сохраняя ошибки.
      // Сложные shell-конструкции не оборачиваем: distill не заменяет shell.
      if (ctx.repowise?.distill && command && !/^\s*repowise\b/.test(command) && !/[|&<>]/.test(command) && hasRepowise()) {
        command = `repowise distill ${command}`;
      }
      return await execute(command, args.cwd || ctx.projectDir);
    },
  },
];

export function execute(command, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let out = '';
    const timer = setTimeout(() => {
      out += `\n[таймаут ${TIMEOUT_MS / 1000} с — процесс остановлен]`;
      child.kill();
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.length > MAX_OUTPUT * 2) child.kill();
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
      if (out.length > MAX_OUTPUT * 2) child.kill();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const trimmed = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n… обрезано` : out;
      resolve(`$ ${command}\n\n${trimmed || '(нет вывода)'}\n\n[код ${code}, ${Date.now() - started} мс]`);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`Ошибка запуска: ${err.message}`);
    });
  });
}
