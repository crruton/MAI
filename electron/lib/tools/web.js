import { fetchPage, webSearch } from '../web.js';

/**
 * web_fetch и web_search (CC1.6, ADR 0056). Класс `network`: без правила
 * спрашивается в каждом режиме, кроме «Без вопросов». Результат — данные
 * (рамка и детектор prompt injection, ADR 0053).
 */
export const webTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Загрузить страницу по адресу (http/https) и вернуть её текст: заголовки, абзацы, ссылки. Для документации, статей, API. Адреса локальной сети недоступны.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            max_chars: { type: 'number', description: 'Сколько символов текста вернуть (по умолчанию 20000)' },
          },
          required: ['url'],
        },
      },
    },
    async run(ctx, args) {
      try {
        const page = await (ctx.webFetch || fetchPage)(args.url, { allowPrivate: Boolean(ctx.webConfig?.allowPrivate), signal: ctx.signal });
        const limit = Math.min(Math.max(Number(args.max_chars) || 20_000, 500), 200_000);
        const text = page.text.length > limit ? `${page.text.slice(0, limit)}\n… ещё ${page.text.length - limit} символов (max_chars)` : page.text;
        return `${page.url} — ${page.status}${page.truncated ? ' (больше 5 МБ, загружено начало)' : ''}\n\n${text || '(пусто)'}`;
      } catch (err) {
        return `Ошибка web_fetch: ${err.message}`;
      }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Поиск в интернете: вернёт заголовки, адреса и фрагменты. Затем открой нужное web_fetch.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number', description: 'Сколько результатов (до 10)' },
          },
          required: ['query'],
        },
      },
    },
    async run(ctx, args) {
      try {
        const results = await (ctx.webSearchImpl || webSearch)(args.query, ctx.webConfig || {}, { limit: Math.min(Math.max(Number(args.limit) || 8, 1), 10) });
        if (!results.length) return `По запросу «${args.query}» ничего не найдено`;
        return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 300)}` : ''}`).join('\n\n');
      } catch (err) {
        return `Ошибка web_search: ${err.message}`;
      }
    },
  },
];
