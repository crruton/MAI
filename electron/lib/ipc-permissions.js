/**
 * Матрица прав IPC (ADR 0028, бэклог A2.2).
 *
 * Каждый канал `ipcMain.handle` обязан быть в этой таблице — это проверяет
 * `scripts/test-ipc-permissions.mjs`. Канал, которого нет в таблице, считается
 * `admin`: ошибка в матрице закрывает доступ, а не открывает.
 *
 * - `any`   — доступно всем ролям: чтение, чат в рамках режима разрешений, экспорт;
 * - `admin` — меняет настройки, запускает процессы, трогает секреты или чужой код;
 * - `self`  — обработчик проверяет роль сам, потому что право зависит от аргументов
 *             (например, «ограниченно» может выбрать гость, «доверяю» — только admin).
 *
 * Локальная роль — режим интерфейса (решение D1): реальной границей матрица
 * становится только при входе через Keycloak.
 */

const ANY = 'any';
const ADMIN = 'admin';
const SELF = 'self';

export const IPC_PERMISSIONS = {
  // настройки и телеметрия
  'settings:get': ANY,
  'settings:save': ADMIN,
  'telemetry:status': ANY,

  // голос и OCR
  'mas:status': ANY,
  'mas:config': ANY,
  'mas:transcribe': ANY,
  'ocr:status': ANY,
  'ocr:recognize': ANY,

  // вход и роли
  'auth:status': ANY,
  'auth:configure': ADMIN,
  'auth:login': ANY,
  'auth:logout': ANY,
  // Переключатель локального режима интерфейса (D1); без него guest заблокировал бы себя.
  'auth:setRole': ANY,

  // модели и провайдеры
  'models:list': ANY,
  'providers:list': ANY,
  'providers:save': ADMIN,
  'providers:remove': ADMIN,
  'providers:test': ANY,

  // внешние рантаймы: процесс с правами пользователя
  'runtimes:list': ANY,
  'runtimes:save': ADMIN,
  'runtimes:probe': ANY,
  'runtimes:run': ADMIN,
  'runtimes:runMany': ADMIN,
  'runtimes:stop': ANY,

  // слэш-команды и упоминания файлов: только чтение
  'commands:list': ANY,
  'commands:expand': ANY,
  'files:search': ANY,

  // проект, доверие, разрешения
  'project:pick': ADMIN,
  'trust:get': ANY,
  'trust:set': SELF,
  'trust:list': ANY,
  'trust:remove': ADMIN,
  'permissions:modes': ANY,
  'permissions:set': SELF,
  'permissions:rules': SELF,
  'permissions:explain': ANY,
  'permissions:audit': ADMIN,

  // вложения: только внутри папки вложений проекта
  'attachments:add': ANY,
  'attachments:addImage': ANY,
  'attachments:pick': ANY,
  'attachments:remove': ANY,
  'attachments:open': ANY,

  // песочницы проектов
  'workspace:root': ANY,
  'workspace:list': ANY,
  'workspace:create': ADMIN,

  // сессии и чат (режим разрешений ограничивает агента отдельно)
  'sessions:list': ANY,
  'sessions:get': ANY,
  'sessions:create': ANY,
  'sessions:delete': ANY,
  'chat:start': ANY,
  'chat:stop': ANY,
  'chat:approval': ANY,
  'chat:answer': ANY,
  'chat:queue': ANY,
  'chat:unqueue': ANY,
  'chat:compact': ANY,
  'hooks:list': ANY,
  'agents:defs': ANY,
  // Пакет — исполняемый код: установка, удаление и включение — только admin.
  'packages:list': ANY,
  'packages:install': ADMIN,
  'packages:uninstall': ADMIN,
  'packages:toggle': ADMIN,
  'context:stats': ANY,
  // Откат возвращает только файлы, которые правил агент в этом чате.
  'checkpoints:turns': ANY,
  'checkpoints:plan': ANY,
  'checkpoints:rewind': ANY,

  // инструкции, память, навыки
  'agents:read': ANY,
  'agents:write': ADMIN,
  'memory:read': ANY,
  'memory:write': ADMIN,
  'memory:save': ADMIN,
  'memory:append': ADMIN,
  'memory:version': ANY,
  'memory:restore': ADMIN,
  'skills:list': ANY,
  'skills:create': ADMIN,
  'skills:delete': ADMIN,

  // Multica
  'multica:status': ANY,
  'multica:install': ADMIN,
  'multica:auth': ADMIN,
  'multica:issues': ANY,
  'multica:syncDocs': ADMIN,

  // Docker-песочницы
  'sandbox:status': ANY,
  'sandbox:list': ANY,
  'sandbox:start': ADMIN,
  'sandbox:stop': ADMIN,
  'sandbox:logs': ANY,
  'sandbox:exec': ADMIN,

  // документация
  'docs:list': ANY,
  'docs:read': ANY,
  'docs:search': ANY,

  // MCP и плагины: запуск процессов и чужого кода
  'mcp:status': ANY,
  'mcp:configs': ANY,
  'mcp:sync': ADMIN,
  'mcp:connect': ADMIN,
  'mcp:remove': ADMIN,
  'mcp:login': ADMIN,
  'mcp:logout': ADMIN,
  'plugins:list': ANY,
  'plugins:openFolder': ANY,
  'plugins:createExample': ADMIN,

  // хранилище артефактов
  'artifacts:list': ANY,
  'artifacts:get': ANY,
  'artifacts:save': ADMIN,
  'artifacts:history': ANY,
  'artifacts:version': ANY,
  'artifacts:restore': ADMIN,
  'artifacts:delete': ADMIN,
  'artifacts:diff': ANY,
  'artifacts:search': ANY,
  'artifacts:import': ADMIN,
  'artifacts:stats': ANY,
  'artifacts:openFolder': ANY,
  'artifacts:export': ANY,
  'artifacts:applyToFile': ADMIN,

  // экспорт ответа
  'export:message': ANY,
  'export:chat': ANY,

  // доски
  'boards:open': ANY,
  'boards:load': ANY,
  'boards:save': ADMIN,
  'boards:views': ANY,
  'boards:baseline': ADMIN,
  'boards:scan': ANY,
  'boards:git': ANY,
  'boards:diff': ANY,
  'boards:stageRun': ADMIN,
  'boards:stageStop': ANY,
  'boards:runtimeStatus': ANY,
  'boards:errors': ANY,
  'boards:clearErrors': ADMIN,
  'boards:correction': ADMIN,
  'boards:correctionStop': ANY,
  'boards:exportView': ANY,
  'boards:exportDiagram': ANY,
  'boards:rasterize': ANY,
  'boards:diagramChat': ADMIN,
  'boards:saveView': ADMIN,

  // инфраструктура: секреты и загрузка файлов
  'infra:status': ANY,
  'infra:sync': ADMIN,
  'infra:pushSecrets': ADMIN,
  'infra:pullSecrets': ADMIN,
  'infra:search': ANY,
  'infra:upload': ADMIN,
  'infra:download': ADMIN,

  // Repowise: установка, индексация и запуск команд
  'repowise:status': ANY,
  'repowise:install': ADMIN,
  'repowise:init': ADMIN,
  'repowise:update': ADMIN,
  'repowise:doctor': ANY,
  'repowise:ask': ANY,
  'repowise:search': ANY,
  'repowise:context': ANY,
  'repowise:risk': ANY,
  'repowise:distill': ADMIN,
  'repowise:connectMcp': ADMIN,
  'repowise:serve': ADMIN,
  'repowise:stopServe': ADMIN,

  // окно и система
  'app:openPath': ANY,
  'app:showItem': ANY,
  'app:openExternal': ANY,
  'app:dataDir': ANY,
  'app:clipboard': ANY,
  'app:focusMain': ANY,
};

export function permissionOf(channel) {
  return IPC_PERMISSIONS[channel] || ADMIN;
}

/**
 * Оборачивает `ipcMain.handle`: проверка роли до вызова обработчика.
 * @param ipcMain   объект Electron
 * @param requireAdmin функция, которая бросает ошибку, если роль не admin
 * @param onUnknown вызывается для канала без записи в матрице
 */
export function guardIpc(ipcMain, requireAdmin, { onUnknown } = {}) {
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => {
    if (!Object.hasOwn(IPC_PERMISSIONS, channel)) onUnknown?.(channel);
    const permission = permissionOf(channel);
    return original(channel, (...args) => {
      if (permission === ADMIN) {
        try {
          requireAdmin();
        } catch (err) {
          // Структурированный отказ вместо исключения: окно показывает ошибку
          // и не остаётся в состоянии «выполняется».
          return { ok: false, forbidden: true, error: err?.message || 'Недостаточно прав' };
        }
      }
      return handler(...args);
    });
  };
  return ipcMain;
}
