import { MEMORY_SCOPES, readMemoryState, saveMemory } from '../memory.js';

/**
 * Инструменты агента для памяти (бэклог №4).
 *
 * `memory_read` — только чтение, подтверждения не требует.
 * `memory_append` — дописывает блок в конец памяти и создаёт версию артефакта.
 * Запись идёт через `saveMemory`, поэтому история версий и откат работают так же,
 * как из панели «Память». Дубль не создаётся: `writeArtifact` сравнивает хеш.
 */

const MAX_APPEND = 20_000;

function scopeOf(value) {
  const scope = String(value || 'project').trim();
  if (!MEMORY_SCOPES.includes(scope)) {
    throw new Error(`Неизвестный уровень памяти: ${scope}. Допустимо: ${MEMORY_SCOPES.join(', ')}`);
  }
  return scope;
}

export const memoryTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'memory_read',
        description:
          'Прочитать память проекта и глобальную память (memory.md) вместе со списком версий. ' +
          'Память уже есть в системном промпте, но инструмент нужен, если она обрезана или нужна история.',
        parameters: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: MEMORY_SCOPES,
              description: 'Какой уровень читать. Без значения — оба.',
            },
          },
        },
      },
    },
    async run(ctx, args) {
      const state = readMemoryState(ctx.projectDir);
      const scope = args?.scope ? scopeOf(args.scope) : '';
      const scopes = scope ? [scope] : MEMORY_SCOPES;
      const parts = [];
      for (const current of scopes) {
        const text = String(state[current] || '').trim();
        const versions = state.versions?.[current] || [];
        const file = current === 'project' ? state.projectFile : state.globalFile;
        parts.push(
          [
            `# ${current === 'project' ? 'Память проекта' : 'Глобальная память'}`,
            `файл: ${file}`,
            `версий: ${versions.length}${versions.length ? `, текущая: v${versions[versions.length - 1].version}` : ''}`,
            '',
            text || '(пусто)',
          ].join('\n'),
        );
      }
      return parts.join('\n\n');
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'memory_append',
        description:
          'Дописать блок в конец памяти (memory.md) и создать версию. Требует подтверждения пользователя. ' +
          'Пиши коротко: решение, причина, границы применимости. Не дублируй то, что уже записано.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Что дописать. Markdown, обычно один пункт списка.' },
            scope: {
              type: 'string',
              enum: MEMORY_SCOPES,
              description: 'Уровень памяти. По умолчанию project.',
            },
            note: { type: 'string', description: 'Короткая пометка к версии для истории' },
          },
          required: ['text'],
        },
      },
    },
    async run(ctx, args) {
      const scope = scopeOf(args?.scope);
      const addition = String(args?.text ?? '').trim();
      if (!addition) return 'Пустой текст: дописывать нечего.';
      if (addition.length > MAX_APPEND) {
        throw new Error(`Слишком длинный блок: ${addition.length} символов, предел ${MAX_APPEND}`);
      }

      const state = readMemoryState(ctx.projectDir);
      const current = String(state[scope] || '');
      if (current.includes(addition)) {
        return `Этот текст уже есть в памяти (${scope}). Версия не создана.`;
      }

      const allowed = await ctx.approve('memory_append', `Дописать в память (${scope}): ${addition.slice(0, 120)}`);
      if (allowed !== true) {
        return typeof allowed === 'string' ? allowed : 'Пользователь отклонил запись в память.';
      }

      const separator = current.trim() ? (current.endsWith('\n') ? '\n' : '\n\n') : '';
      const next = `${current}${separator}${addition}\n`;
      const result = saveMemory(ctx.projectDir, {
        scope,
        content: next,
        note: args?.note || 'запись агентом через memory_append',
      });

      return [
        `Память обновлена: ${scope}`,
        `файл: ${result.file}`,
        `версия: ${result.changed ? `v${result.version}` : 'без изменений'}`,
        `всего версий: ${result.versions.length}`,
      ].join('\n');
    },
  },
];
