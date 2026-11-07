/**
 * Режимы разрешений — как в Claude Code.
 *
 * Режим решает, что делать с запросом инструмента на опасное действие:
 * разрешить молча, спросить пользователя или отказать.
 *
 * Guardrails проверяются раньше и работают во всех режимах: режим «авто»
 * не отключает защиту от разрушительных команд и секретов.
 */

export const PERMISSION_MODES = ['auto', 'manual', 'acceptEdits', 'plan'];

export const DEFAULT_PERMISSION_MODE = 'manual';

export const MODE_INFO = {
  auto: {
    id: 'auto',
    label: 'Авто',
    short: 'Авто',
    description: 'Агент сам решает, что можно делать. Опасные команды по-прежнему блокируют guardrails.',
  },
  manual: {
    id: 'manual',
    label: 'Вручную',
    short: 'Вручную',
    description: 'Приложение спрашивает перед каждой записью файла и каждой командой оболочки.',
  },
  acceptEdits: {
    id: 'acceptEdits',
    label: 'Принимать правки',
    short: 'Правки',
    description: 'Правки файлов применяются без вопросов. Команды оболочки всё равно требуют подтверждения.',
  },
  plan: {
    id: 'plan',
    label: 'План',
    short: 'План',
    description: 'Агент только читает и предлагает план с альтернативами. Файлы не меняются, команды не запускаются.',
  },
};

/** Инструменты, которые меняют файлы проекта. */
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

/** Инструменты, которые запускают процессы. */
const SHELL_TOOLS = new Set(['run_shell']);

/** Инструменты, которые только читают. Их не спрашиваем ни в одном режиме. */
const READ_TOOLS = new Set([
  'read_file',
  'list_files',
  'grep',
  'load_skill',
  'web_fetch',
  'web_search',
]);

export function normalizeMode(value) {
  const mode = String(value || '').trim();
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
 * Решает судьбу запроса на разрешение.
 *
 * Возвращает:
 * - `{ action: 'allow' }` — выполнить без вопроса;
 * - `{ action: 'ask' }` — спросить пользователя;
 * - `{ action: 'deny', reason }` — отказать, инструмент получит причину.
 */
export function decide({ mode, tool, guardrails } = {}) {
  const current = normalizeMode(mode);
  const name = String(tool || '');

  // Чтение не спрашиваем никогда: это не меняет состояние.
  if (isReadTool(name)) return { action: 'allow' };

  // MCP-инструменты и плагины неизвестны заранее — считаем их опасными.
  const isWrite = isWriteTool(name);
  const isShell = isShellTool(name);
  const isUnknown = !isWrite && !isShell;

  if (current === 'plan') {
    return {
      action: 'deny',
      reason:
        'Режим «План»: изменения запрещены. Опиши план и альтернативы, затем попроси пользователя переключить режим.',
    };
  }

  if (current === 'auto') {
    // Guardrails уже проверили команду до вызова approve. Здесь разрешаем.
    return { action: 'allow' };
  }

  if (current === 'acceptEdits') {
    if (isWrite) return { action: 'allow' };
    return { action: 'ask' };
  }

  // manual: спрашиваем про всё, что меняет состояние.
  if (isWrite || isShell || isUnknown) return { action: 'ask' };
  return { action: 'ask' };
}

/**
 * Инструменты, которые нельзя показывать модели в режиме «План».
 * Модель не должна даже пытаться писать: это экономит итерации.
 */
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
      'Ты не меняешь файлы и не запускаешь команды. Инструменты записи отключены.',
      'Сначала изучи проект инструментами read_file, list_files и grep.',
      'Затем выдай план в таком виде:',
      '1. Цель — что нужно получить.',
      '2. Альтернативы — минимум два подхода, у каждого плюсы, минусы и риск.',
      '3. Рекомендация — какой вариант выбрать и почему.',
      '4. Шаги — конкретные файлы и функции, которые будут изменены.',
      '5. Проверка — какие команды и тесты подтвердят результат.',
      'В конце попроси пользователя переключить режим на «Вручную» или «Принимать правки», чтобы выполнить план.',
    ].join('\n');
  }
  if (current === 'auto') {
    return [
      '# Режим: Авто',
      'Пользователь разрешил выполнять правки и команды без подтверждения.',
      'Guardrails по-прежнему блокируют разрушительные команды и доступ к секретам.',
      'Действуй осторожно: не удаляй данные и не коммить в git без явной просьбы.',
    ].join('\n');
  }
  if (current === 'acceptEdits') {
    return [
      '# Режим: Принимать правки',
      'Правки файлов применяются без подтверждения. Команды оболочки требуют подтверждения.',
      'Перед правкой прочитай файл. После правки проверь результат.',
    ].join('\n');
  }
  return [
    '# Режим: Вручную',
    'Пользователь подтверждает каждую запись файла и каждую команду оболочки.',
    'Объясняй коротко, что собираешься сделать, чтобы подтверждение было осознанным.',
  ].join('\n');
}
