/**
 * Каталог коннекторов (бэклог CW3.1, ADR 0052): готовые подключения MCP в два
 * клика. Встроенные — только официальные удалённые серверы сервисов; свои —
 * у организации в `managed-settings.json` (поле `connectors`, ADR 0038).
 *
 * auth: 'oauth' — вход в браузере (ADR 0041, нужен DCR на стороне сервиса);
 *       'token' — токен пользователя в заголовке (хранится зашифрованным).
 *
 * Модуль не зависит от Electron.
 */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const BUILTIN_CONNECTORS = [
  {
    id: 'linear',
    name: 'Linear',
    category: 'Задачи',
    description: 'Задачи, проекты и комментарии Linear.',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    docs: 'https://linear.app/docs/mcp',
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'Вики и документы',
    description: 'Страницы и базы Notion: поиск, чтение, создание.',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    docs: 'https://developers.notion.com/docs/mcp',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Код',
    description: 'Репозитории, issues и pull requests. Нужен персональный токен (fine-grained PAT).',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'token',
    tokenHint: 'github_pat_…',
    tokenUrl: 'https://github.com/settings/personal-access-tokens/new',
    docs: 'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'Мониторинг',
    description: 'Ошибки и события Sentry.',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth',
    docs: 'https://docs.sentry.io/product/sentry-mcp/',
  },
];

function cleanConnector(raw, source) {
  const id = String(raw?.id || '').toLowerCase();
  const url = String(raw?.url || '');
  if (!ID_RE.test(id) || !/^https:\/\//.test(url)) return null;
  return {
    id,
    name: String(raw.name || id).slice(0, 60),
    category: String(raw.category || 'Другое').slice(0, 40),
    description: String(raw.description || '').slice(0, 300),
    url,
    auth: raw.auth === 'token' ? 'token' : raw.auth === 'none' ? 'none' : 'oauth',
    tokenHeader: /^[A-Za-z0-9-]{1,40}$/.test(String(raw.tokenHeader || '')) ? raw.tokenHeader : 'Authorization',
    tokenPrefix: raw.tokenPrefix === '' ? '' : String(raw.tokenPrefix ?? 'Bearer ').slice(0, 20),
    tokenHint: String(raw.tokenHint || '').slice(0, 60),
    tokenUrl: /^https:\/\//.test(String(raw.tokenUrl || '')) ? raw.tokenUrl : '',
    docs: /^https:\/\//.test(String(raw.docs || '')) ? raw.docs : '',
    source,
  };
}

/** Каталог: организация сильнее встроенного с тем же id. `onlyManaged` — организация запретила встроенные. */
export function listConnectors({ managed = [], onlyManaged = false } = {}) {
  const out = new Map();
  if (!onlyManaged) for (const c of BUILTIN_CONNECTORS) out.set(c.id, cleanConnector(c, 'builtin'));
  for (const raw of Array.isArray(managed) ? managed : []) {
    const c = cleanConnector(raw, 'managed');
    if (c) out.set(c.id, c);
  }
  return [...out.values()].filter(Boolean);
}

/** Запись для `settings.mcpServers`: url и, для token, заголовок с токеном. */
export function connectorServerConfig(connector, { token = '' } = {}) {
  const config = { url: connector.url, connector: connector.id };
  if (connector.auth === 'token') {
    const value = String(token || '').trim();
    if (!value) throw new Error(`Для ${connector.name} нужен токен`);
    if (/[\r\n]/.test(value)) throw new Error('Токен не может содержать перевод строки');
    config.headers = { [connector.tokenHeader || 'Authorization']: `${connector.tokenPrefix ?? 'Bearer '}${value}` };
    config.oauth = false;
  } else if (connector.auth === 'none') {
    config.oauth = false;
  }
  return config;
}
