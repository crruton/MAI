import { ask, context, risk, search } from '../repowise.js';

/**
 * Инструменты Repowise для встроенного агента.
 * Включаются только если в настройках repowise.enabled = true.
 * Альтернатива — MCP-сервер repowise с десятью инструментами.
 */
export const repowiseTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'repowise_ask',
        description:
          'Спросить локальный индекс Repowise о кодовой базе: архитектура, зависимости, что сломается. Дешевле, чем читать файлы вручную.',
        parameters: {
          type: 'object',
          properties: { question: { type: 'string', description: 'Вопрос по репозиторию' } },
          required: ['question'],
        },
      },
    },
    async run(ctx, args) {
      const res = await ask(ctx.projectDir, args.question);
      return res.output || '(пустой ответ)';
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'repowise_context',
        description: 'Карточка файлов из индекса Repowise: слой, hotspot, зависимости, история исправлений.',
        parameters: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Пути файлов относительно проекта',
            },
          },
          required: ['files'],
        },
      },
    },
    async run(ctx, args) {
      const res = await context(ctx.projectDir, args.files || []);
      return res.output || '(пустой ответ)';
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'repowise_risk',
        description: 'Оценить риск изменений в диапазоне git: что сломается, какие тесты запустить.',
        parameters: {
          type: 'object',
          properties: {
            range: { type: 'string', description: 'Диапазон git, по умолчанию main..HEAD' },
          },
        },
      },
    },
    async run(ctx, args) {
      const res = await risk(ctx.projectDir, args.range || 'main..HEAD');
      return res.output || '(пустой ответ)';
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'repowise_search',
        description: 'Гибридный поиск Repowise по коду и документации (символы, пути, понятия).',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    },
    async run(ctx, args) {
      const res = await search(ctx.projectDir, args.query);
      return res.output || '(пустой ответ)';
    },
  },
];
