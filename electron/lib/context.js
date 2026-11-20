/**
 * Контекст модели: оценка, разбор по частям, компакция (бэклог CC5.1–CC5.3).
 *
 * Точное число токенов знает только провайдер (usage.input последнего шага).
 * До первого ответа — оценка по символам. Компакция заменяет старую часть
 * истории сводкой: в сессии остаётся маркер `role: 'compaction'`, модели
 * уходит сводка и сообщения после маркера. Полная история не удаляется.
 *
 * Модуль не зависит от Electron.
 */

export const DEFAULT_CONTEXT = 128_000;
export const AUTO_COMPACT_AT = 0.8;

/** Грубая оценка: ~3 символа на токен для смеси кириллицы, кода и JSON. */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(text.length / 3);
}

/** Сообщения, которые видит модель: после последнего маркера компакции, сводка — первым. */
export function activeHistory(history) {
  let index = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === 'compaction') {
      index = i;
      break;
    }
  }
  if (index === -1) return history;
  const marker = history[index];
  return [
    { role: 'user', content: `[Сводка предыдущей части диалога — она заменяет ранние сообщения]\n\n${marker.content}` },
    ...history.slice(index + 1),
  ];
}

/**
 * Последний известный размер запроса от провайдера и что добавилось после:
 * usage.input + usage.output того ответа + оценка более поздних сообщений.
 */
export function lastKnownTokens(history) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i];
    if (m?.role === 'compaction') return null;
    if (m?.role === 'assistant' && m.usage?.input) {
      const after = history.slice(i + 1).reduce((n, x) => n + estimateTokens(x.content) + estimateTokens(x.tool_calls || ''), 0);
      return m.usage.input + (m.usage.output || 0) + after;
    }
  }
  return null;
}

/**
 * Разбор контекста по частям для /context.
 * @returns {{ window, used, exact, parts: Array<{ key, label, tokens }> }}
 */
export function contextBreakdown({ system = '', tools = [], history = [], window = DEFAULT_CONTEXT }) {
  const active = activeHistory(history);
  const sum = (filter) => active.filter(filter).reduce((n, m) => n + estimateTokens(m.content) + estimateTokens(m.tool_calls || ''), 0);
  const parts = [
    { key: 'system', label: 'Системный промпт, AGENTS.md, память', tokens: estimateTokens(system) },
    { key: 'tools', label: `Описания инструментов (${tools.length})`, tokens: estimateTokens(tools) },
    { key: 'summary', label: 'Сводка после компакции', tokens: active === history ? 0 : estimateTokens(active[0].content) },
    { key: 'user', label: 'Сообщения пользователя', tokens: sum((m, i) => m.role === 'user' && !(active !== history && i === 0)) },
    { key: 'assistant', label: 'Ответы агента и вызовы', tokens: sum((m) => m.role === 'assistant') },
    { key: 'tool', label: 'Результаты инструментов', tokens: sum((m) => m.role === 'tool') },
    { key: 'other', label: 'Рантаймы и ревизор', tokens: sum((m) => m.role === 'runtime' || m.role === 'review') },
  ];
  const estimated = parts.reduce((n, p) => n + p.tokens, 0);
  const exact = lastKnownTokens(history);
  return { window, used: exact || estimated, exact: Boolean(exact), estimated, parts };
}

/**
 * Где резать для компакции: оставить последние ходы, которые вместе не больше
 * `keepTokens`, и всегда хотя бы последнее сообщение пользователя с ответом.
 * Режем только по границе хода (перед сообщением пользователя) — пары
 * tool_calls → tool не разрываются. Возвращает индекс в history или -1.
 */
export function compactionCut(history, { keepTokens = 20_000 } = {}) {
  const start = (() => {
    for (let i = history.length - 1; i >= 0; i -= 1) if (history[i]?.role === 'compaction') return i + 1;
    return 0;
  })();
  const userIdx = [];
  for (let i = start; i < history.length; i += 1) if (history[i]?.role === 'user') userIdx.push(i);
  if (userIdx.length < 2) return -1; // сжимать нечего: один ход
  let cut = userIdx[userIdx.length - 1];
  for (let k = userIdx.length - 2; k >= 1; k -= 1) {
    const kept = history.slice(userIdx[k]).reduce((n, m) => n + estimateTokens(m.content) + estimateTokens(m.tool_calls || ''), 0);
    if (kept > keepTokens) break;
    cut = userIdx[k];
  }
  return cut > start ? cut : -1;
}

/** Текст для модели-суммаризатора. */
export function compactionPrompt(messages, instructions = '') {
  const lines = messages.map((m) => {
    if (m.role === 'compaction') return `## Ранняя сводка\n${m.content}`;
    if (m.role === 'tool') return `## Результат ${m.name || 'инструмента'}\n${String(m.content || '').slice(0, 4000)}`;
    if (m.role === 'assistant') {
      const calls = (m.tool_calls || []).map((c) => `вызов ${c.function?.name}(${String(c.function?.arguments || '').slice(0, 400)})`).join('\n');
      return `## Агент\n${m.content || ''}${calls ? `\n${calls}` : ''}`;
    }
    return `## ${m.role === 'user' ? 'Пользователь' : m.role}\n${String(m.display || m.content || '').slice(0, 8000)}`;
  });
  return [
    'Сожми эту часть диалога агента с пользователем в сводку, которой хватит, чтобы продолжить работу без исходных сообщений.',
    'Сохрани: цель и требования пользователя, принятые решения и почему, изменённые файлы и что в них сделано,',
    'команды и их результаты (ошибки — дословно), что проверено, что осталось сделать, открытые вопросы.',
    'Не выдумывай. Пиши по-русски, списками, без вступлений.',
    instructions ? `Особо учти: ${instructions}` : '',
    '',
    ...lines,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Нужна ли автокомпакция перед следующим запросом. */
export function needsCompaction(history, { window = DEFAULT_CONTEXT, threshold = AUTO_COMPACT_AT, system = '', tools = [] } = {}) {
  const { used } = contextBreakdown({ system, tools, history, window });
  return used >= window * threshold;
}
