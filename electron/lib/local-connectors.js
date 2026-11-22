/**
 * Локальные коннекторы (CW3.3, ADR 0072): сервисы, которые MAI уже умеет —
 * Repowise, Multica, Postgres, Vault, SeaweedFS из «Хранилища», — карточками
 * в том же каталоге, что и удалённые коннекторы. Здесь только сборка карточек
 * из проверок; сами проверки делает main. Модуль не зависит от Electron.
 *
 * status: 'ready' — работает; 'off' — есть, но выключен; 'missing' — не
 * установлен или не настроен; 'error' — настроен, но не отвечает.
 * action: { kind: 'toggle', enabled } — включить/выключить здесь же;
 *         { kind: 'open', target } — открыть настройку (панель или вкладку «Хранилища»).
 */
const STORAGE = { kind: 'open', target: 'storage:infra', label: 'Настроить' };

function service(id, name, description, check, { notConfigured }) {
  if (!check || check.error === 'URL не задан' || check.error === 'не проверялся' || check.configured === false) {
    return { id, name, description, status: 'missing', detail: notConfigured, action: STORAGE };
  }
  if (check.ok) return { id, name, description, status: 'ready', detail: check.version || 'отвечает', action: STORAGE };
  return { id, name, description, status: 'error', detail: String(check.error || 'не отвечает').slice(0, 200), action: STORAGE };
}

export function localConnectors({ repowise = null, repowiseEnabled = false, multica = null, infra = null, config = {} } = {}) {
  const cards = [];
  // Repowise: индекс кода и инструменты repowise_* для агента в чатах «Код».
  if (!repowise?.installed) {
    cards.push({ id: 'repowise', name: 'Repowise', description: 'Индекс кода: вопросы по репозиторию, контекст файлов, риски изменений — инструменты repowise_* в чатах «Код».', status: 'missing', detail: 'CLI не установлен', action: { kind: 'open', target: 'storage:repowise', label: 'Установить' } });
  } else {
    cards.push({
      id: 'repowise',
      name: 'Repowise',
      description: 'Индекс кода: вопросы по репозиторию, контекст файлов, риски изменений — инструменты repowise_* в чатах «Код».',
      status: repowiseEnabled ? 'ready' : 'off',
      detail: repowise.version || '',
      action: { kind: 'toggle', enabled: repowiseEnabled, label: repowiseEnabled ? 'Выключить' : 'Включить' },
      extra: { kind: 'open', target: 'storage:repowise', label: 'Индекс' },
    });
  }
  // Multica: доска задач агентов.
  cards.push(
    multica?.available
      ? { id: 'multica', name: 'Multica', description: 'Задачи и доска агентов Multica, синхронизация OpenSpec.', status: multica.error ? 'error' : 'ready', detail: multica.error || multica.version || '', action: { kind: 'open', target: 'panel:multica', label: 'Открыть' } }
      : { id: 'multica', name: 'Multica', description: 'Задачи и доска агентов Multica, синхронизация OpenSpec.', status: 'missing', detail: multica?.error || 'CLI не найден', action: { kind: 'open', target: 'panel:multica', label: 'Установить' } },
  );
  cards.push(service('postgres', 'Postgres', 'Хранилище артефактов и поиск по смыслу (pgvector).', infra?.postgres && { ...infra.postgres, configured: Boolean(config.postgresUrl) }, { notConfigured: 'адрес не задан' }));
  if (cards.at(-1).status === 'ready' && infra?.postgres && !infra.postgres.pgvector) cards.at(-1).detail = `${cards.at(-1).detail}, без pgvector`;
  cards.push(service('vault', 'Vault', 'Секреты команды: ключи провайдеров из Vault.', infra?.vault && { ...infra.vault, configured: Boolean(config.vaultAddr) }, { notConfigured: 'адрес не задан' }));
  cards.push(service('seaweed', 'SeaweedFS', 'Файлы артефактов в объектном хранилище.', infra?.seaweed && { ...infra.seaweed, configured: Boolean(config.seaweedUrl) }, { notConfigured: 'адрес не задан' }));
  return cards.map((c) => ({ ...c, category: 'Локальные', local: true }));
}
