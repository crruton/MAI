/**
 * Режимы разрешений — как в Claude Code.
 *
 * Режим решает, что делать с запросом инструмента на опасное действие:
 * разрешить молча, спросить пользователя или отказать.
 *
 * Guardrails и правила deny проверяются раньше и работают во всех режимах:
 * режим «Без вопросов» не отключает защиту от разрушительных команд и секретов.
 * Полное решение принимает PolicyEngine (policy.js, ADR 0027).
 */

export const PERMISSION_MODES = ['manual', 'acceptEdits', 'plan', 'dontAsk', 'bypass'];

export const DEFAULT_PERMISSION_MODE = 'manual';

/**
 * Старые значения режима. До ADR 0027 режим «Авто» разрешал всё без вопросов,
 * поэтому сохранённое `auto` переводится в `bypass` — поведение пользователя
 * не меняется молча. Новый «Авто» с классификатором появится отдельным id.
 */
const LEGACY_MODES = { auto: 'bypass' };

export const MODE_INFO = {
  manual: {
    id: 'manual',
    label: 'Вручную',
    short: 'Вручную',
    description: 'Спрашивать перед каждой правкой, командой и внешним инструментом. Чтение — без вопросов.',
  },
  acceptEdits: {
    id: 'acceptEdits',
    label: 'Принимать правки',
    short: 'Правки',
    description: 'Правки файлов проекта — без вопросов. Команды, память и внешние инструменты — с подтверждением.',
  },
  plan: {
    id: 'plan',
    label: 'План',
    short: 'План',
    description: 'Только чтение и план с альтернативами. Запись, команды, MCP и плагины с действиями отключены.',
  },
  dontAsk: {
    id: 'dontAsk',
    label: 'Только разрешённое',
    short: 'Разрешённое',
    description: 'Выполняется только то, что разрешено правилами. Остальное отклоняется без вопроса. Для фоновых задач.',
  },
  bypass: {
    id: 'bypass',
    label: 'Без вопросов',
    short: 'Без вопросов',
    description:
      'Всё выполняется без подтверждения. Защищают только guardrails и правила deny. Недоступен гостю.',
    warning: true,
    adminOnly: true,
  },
};

/** Классы, которые меняют состояние (для обратной совместимости тестов и UI). */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'memory_append']);
const SHELL_TOOLS = new Set(['run_shell']);
const READ_TOOLS = new Set([
  'read_file',
  'list_files',
  'grep',
  'load_skill',
  'memory_read',
  'repowise_ask',
  'repowise_context',
  'repowise_risk',
  'repowise_search',
  'ask_user',
  'exit_plan',
  'todo_write',
  'agent',
]);

export function normalizeMode(value) {
  const raw = String(value || '').trim();
  const mode = LEGACY_MODES[raw] || raw;
  return PERMISSION_MODES.includes(mode) ? mode : DEFAULT_PERMISSION_MODE;
}

export function isWriteTool(name) {
  return WRITE_TOOLS.has(String(name || ''));
}

export function isShellTool(name) {
  return SHELL_TOOLS.has(String(name || ''));
}

export function isReadTool(name) {
  return READ_TOOLS.has(String(name || ''));
}

/**
 * Упрощённое решение без правил и аргументов. Полная проверка — `evaluate`
 * в policy.js; эта функция оставлена для старых вызовов и тестов.
 */
export function decide({ mode, tool } = {}) {
  const current = normalizeMode(mode);
  const name = String(tool || '');
  if (isReadTool(name)) return { action: 'allow' };
  if (current === 'plan') {
    return {
      action: 'deny',
      reason:
        'Режим «План»: изменения запрещены. Опиши план и альтернативы, затем попроси пользователя переключить режим.',
    };
  }
  if (current === 'bypass') return { action: 'allow' };
  if (current === 'dontAsk') {
    return { action: 'deny', reason: 'Режим «Только разрешённое»: действие не покрыто правилом allow.' };
  }
  if (current === 'acceptEdits' && (name === 'write_file' || name === 'edit_file')) return { action: 'allow' };
  return { action: 'ask' };
}

/** Встроенные инструменты, скрытые в режиме «План». Полный фильтр — по классу в agent.js. */
export function hiddenToolsForMode(mode) {
  if (normalizeMode(mode) !== 'plan') return new Set();
  return new Set([...WRITE_TOOLS, ...SHELL_TOOLS]);
}

/** Дополнительная инструкция для системного промпта под текущий режим. */
export function modePrompt(mode) {
  const current = normalizeMode(mode);
  if (current === 'plan') {
    return [
      '# Режим: План',
      'Ты не меняешь файлы и не запускаешь команды. Инструменты записи, команд и внешние инструменты с действиями отключены.',
      'Сначала изучи проект инструментами read_file, list_files и grep.',
      'Если решение за пользователем, спроси через ask_user и отметь рекомендованный вариант.',
      'Затем выдай план в таком виде:',
      '1. Цель — что нужно получить.',
      '2. Альтернативы — минимум два подхода, у каждого плюсы, минусы и риск.',
      '3. Рекомендация — какой вариант выбрать и почему.',
      '4. Шаги — конкретные файлы и функции, которые будут изменены.',
      '5. Проверка — какие команды и тесты подтвердят результат.',
      'Готовый план сдай инструментом exit_plan: план, альтернативы и номер рекомендованной.',
      'Не проси переключить режим текстом — режим переключит пользователь в карточке плана.',
    ].join('\n');
  }
  if (current === 'bypass') {
    return [
      '# Режим: Без вопросов',
      'Пользователь разрешил выполнять правки и команды без подтверждения.',
      'Guardrails и правила deny по-прежнему блокируют разрушительные команды и доступ к секретам.',
      'Действуй осторожно: не удаляй данные и не коммить в git без явной просьбы.',
    ].join('\n');
  }
  if (current === 'dontAsk') {
    return [
      '# Режим: Только разрешённое',
      'Пользователя не спрашивают. Выполняется только то, что разрешено правилами allow.',
      'Если инструмент вернул отказ, не повторяй вызов: опиши, какое разрешение нужно, и продолжай без него.',
    ].join('\n');
  }
  if (current === 'acceptEdits') {
    return [
      '# Режим: Принимать правки',
      'Правки файлов проекта применяются без подтверждения. Команды, память и внешние инструменты требуют подтверждения.',
      'Перед правкой прочитай файл. После правки проверь результат.',
    ].join('\n');
  }
  return [
    '# Режим: Вручную',
    'Пользователь подтверждает каждую запись файла, каждую команду и каждый внешний инструмент.',
    'Объясняй коротко, что собираешься сделать, чтобы подтверждение было осознанным.',
  ].join('\n');
}
