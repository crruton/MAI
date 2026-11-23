import fs from 'node:fs';
import { resolveInside } from './fs.js';
import { runDiagnostics, formatDiagnostics } from '../diagnostics.js';

/**
 * Инструмент diagnostics (CC1.11, ADR 0079): ошибки компилятора и линтера
 * проекта. Запускает программы проекта (tsc, eslint, ruff, pyright) — поэтому
 * только в доверенной папке: это тот же уровень, что и хуки и плагины проекта.
 */
export const diagnosticsTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'diagnostics',
        description:
          'Ошибки компилятора и линтера проекта (TypeScript, ESLint, Ruff/Pyright; без них — синтаксис JS и Python): файл:строка:колонка и сообщение. ' +
          'path — один файл; без path — весь проект. Проверяй после правок, прежде чем сказать, что готово.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Файл; пусто — весь проект' } } },
      },
    },
    precheck(ctx) {
      if (ctx.trusted === false) return 'Диагностика запускает программы проекта — только в доверенной папке.';
      return null;
    },
    async run(ctx, args) {
      const file = args.path ? resolveInside(ctx, args.path) : '';
      if (file && !fs.existsSync(file)) return `Файл не найден: ${file}`;
      return formatDiagnostics(await runDiagnostics(ctx.projectDir, { file, signal: ctx.signal }), ctx.projectDir);
    },
  },
];
