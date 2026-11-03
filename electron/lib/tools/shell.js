import { spawn } from 'node:child_process';

const MAX_OUTPUT = 24_000;
const TIMEOUT_MS = 180_000;

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
      const allowed = await ctx.approve('run_shell', args.command);
      if (!allowed) return 'Пользователь отклонил выполнение команды.';
      let command = String(args.command || '');
      // Repowise distill сжимает вывод тестов/установки/гита, сохраняя ошибки.
      // Сложные shell-конструкции не оборачиваем: distill не заменяет shell.
      if (ctx.repowise?.distill && command && !/^\s*repowise\b/.test(command) && !/[|&<>]/.test(command)) {
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
