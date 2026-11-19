/**
 * Список задач агента (бэклог CC1.5).
 *
 * Агент ведёт план многошаговой задачи: каждый вызов заменяет список целиком.
 * Окно показывает его над полем ввода. Список живёт в истории (аргументы
 * последнего вызова), отдельного хранилища нет. Класс `read`: файлы не меняются.
 */

const STATUSES = ['pending', 'in_progress', 'completed'];
const MAX_TODOS = 30;

export function normalizeTodos(args) {
  const list = Array.isArray(args?.todos) ? args.todos : null;
  if (!list) throw new Error('Нужен массив todos');
  if (list.length > MAX_TODOS) throw new Error(`Не больше ${MAX_TODOS} задач`);
  const todos = list.map((item, index) => {
    const content = String(item?.content ?? '').trim().slice(0, 300);
    if (!content) throw new Error(`Задача ${index + 1}: пустой текст`);
    const status = STATUSES.includes(item?.status) ? item.status : 'pending';
    const activeForm = String(item?.activeForm ?? '').trim().slice(0, 300);
    return { content, status, ...(activeForm ? { activeForm } : {}) };
  });
  if (todos.filter((t) => t.status === 'in_progress').length > 1) {
    throw new Error('В работе может быть только одна задача: заверши текущую, прежде чем брать следующую');
  }
  return todos;
}

/** Последний список задач из истории сессии — для восстановления при открытии чата. */
export function lastTodos(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const calls = messages[i]?.tool_calls || [];
    for (let j = calls.length - 1; j >= 0; j -= 1) {
      if (calls[j]?.function?.name !== 'todo_write') continue;
      try {
        return normalizeTodos(JSON.parse(calls[j].function.arguments || '{}'));
      } catch {
        return [];
      }
    }
  }
  return [];
}

export const todoTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'todo_write',
        description:
          'Вести список задач для многошаговой работы (3 шага и больше). Каждый вызов заменяет список целиком. ' +
          'Ровно одна задача in_progress; отмечай completed сразу после выполнения, не пачкой в конце.',
        parameters: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              maxItems: MAX_TODOS,
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string', description: 'Что сделать, повелительно: «Добавить тест»' },
                  activeForm: { type: 'string', description: 'Как показать в работе: «Добавляю тест»' },
                  status: { type: 'string', enum: STATUSES },
                },
                required: ['content', 'status'],
              },
            },
          },
          required: ['todos'],
        },
      },
    },
    precheck(_ctx, args) {
      try {
        normalizeTodos(args);
        return null;
      } catch (err) {
        return `Ошибка: ${err.message}`;
      }
    },
    async run(ctx, args) {
      const todos = normalizeTodos(args);
      ctx.todos?.(todos);
      const done = todos.filter((t) => t.status === 'completed').length;
      const current = todos.find((t) => t.status === 'in_progress');
      return `Список задач обновлён: ${done} из ${todos.length} выполнено${current ? `, в работе: ${current.content}` : ''}.`;
    },
  },
];
