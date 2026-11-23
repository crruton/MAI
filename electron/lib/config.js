import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { createSecretBox, openSettings, sealSettings, keepUnreadable, plaintextSecrets } from './secrets.js';
import { envCandidates, readEnvFiles } from './env.js';
import { RUNTIME_PRESETS } from './runtimes.js';
import { DEFAULT_GUARDRAILS } from './guardrails.js';
import { normalizeShellSandbox } from './shell-sandbox.js';

const DEFAULTS = {
  temperature: 0.3,
  maxIterations: 30,
  // Режим разрешений: manual | acceptEdits | plan | dontAsk | bypass (lib/permissions.js).
  permissionMode: 'manual',
  // Правила разрешений (ADR 0027): `инструмент` или `инструмент(маска)`.
  // deny сильнее ask, ask сильнее allow. Пример: "run_shell(npm test*)".
  permissions: { allow: [], ask: [], deny: [] },
  allowOutsideProject: false,
  // Браузер агента (CW4.1, CW4.2, ADR 0069).
  browserEnabled: true,
  browserSites: { allow: [], block: [] },
  // Чаты (CC6.8, CC6.9): автозаголовок моделью, срок хранения в днях (0 — бессрочно).
  autoTitle: true,
  // Диагностика после правок кода (CC1.11): tsc/eslint/ruff проекта — может быть медленной.
  autoDiagnostics: false,
  // Инструкции других агентов (CC4.6): CLAUDE.md, GEMINI.md, правила Cursor и Copilot.
  compatInstructions: true,
  // Уведомления (CW5.4): на рабочем столе и в мессенджер через webhook.
  notifications: { enabled: true, desktop: ['done', 'approval', 'question', 'error', 'background', 'scheduled'], channels: [] },
  // Отложенные инструменты (CC1.12): больше стольких MCP/плагинов — схемы по запросу (0 — никогда).
  deferToolsOver: 25,
  sessionRetentionDays: 0,
  guardrails: DEFAULT_GUARDRAILS,
  telemetry: {
    enabled: false,
    endpoint: 'http://127.0.0.1:4318',
    serviceName: 'mai-code',
  },
  projectDir: '',
  theme: 'dark',
  activeModel: '',
  providers: {},
  runtimes: {},
  infra: {
    enabled: false,
    postgresUrl: 'postgres://mai:mai@127.0.0.1:5433/mai',
    vaultAddr: 'http://127.0.0.1:8200',
    vaultToken: '',
    seaweedUrl: 'http://127.0.0.1:8888',
    embeddingProvider: 'mai',
    embeddingModel: 'bge-m3',
    dimension: 1024,
  },
  repowise: {
    enabled: false,
    distill: true,
  },
  reviewer: {
    enabled: false,
    model: '',
    maxRounds: 2,
  },
  multica: {
    url: 'http://localhost:8080',
    appUrl: 'http://localhost:3000',
    workspaceId: '',
    command: 'multica',
  },
  // Локальный MAS: распознавание речи для кнопки микрофона.
  mas: {
    enabled: true,
    url: 'http://127.0.0.1:8765',
    token: '',
    model: 'gigaam-v3-e2e-ctc',
  },
  // OCR: распознавание текста на изображениях. Движки — см. lib/ocr.js.
  ocr: {
    enabled: true,
    // auto | winrt | vision | tesseract | mai | off
    engine: 'auto',
    language: 'ru',
    provider: 'mai',
    model: 'hunyuan-ocr',
    maxDimension: 4000,
    scale: 1,
    timeoutMs: 60000,
  },
};

// Модели, которые показываем, если шлюз не отдал /models.
const STATIC_MODELS = {
  agentrouter: [
    { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', context: null },
    { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', context: null },
  ],
  mai: [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context: 1048576 },
    { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', context: 1048576 },
    { id: 'qwen3.8-27b', name: 'Qwen 3.8 27B', context: 262144 },
    { id: 'qwen3.8-flash-next', name: 'Qwen 3.8 Flash Next', context: 262144 },
  ],
};

// AgentRouter пропускает только клиент Claude Code: с другим User-Agent отдаёт
// 401 «unauthorized client detected». Провайдер MAI на User-Agent не реагирует.
const PROVIDER_USER_AGENT = { agentrouter: 'claude-cli/1.0.0 (external, cli)' };
// Резерв по хосту: помогает старым settings.json без поля userAgent.
const HOST_USER_AGENT = { 'agentrouter.org': 'claude-cli/1.0.0 (external, cli)' };
/** User-Agent для запросов к шлюзу провайдера ('' — дефолт SDK). */
export function providerUserAgent(providerId, provider) {
  const explicit = String(provider?.userAgent || PROVIDER_USER_AGENT[providerId] || '');
  if (explicit) return explicit;
  try {
    const host = new URL(String(provider?.baseURL || '')).hostname.toLowerCase();
    return HOST_USER_AGENT[host] || '';
  } catch {
    return '';
  }
}
function dataDir() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function settingsPath() {
  return path.join(dataDir(), 'settings.json');
}

function readKeyFromDevFile() {
  const candidates = [
    'C:/Users/User/Desktop/dev/mai-api-key.txt',
    path.join(process.env.USERPROFILE || '', 'Desktop', 'dev', 'mai-api-key.txt'),
  ];
  for (const file of candidates) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      /* нет файла — не страшно */
    }
  }
  return '';
}

function loadEnv() {
  const files = envCandidates({
    dataDir: dataDir(),
    appDir: app.getAppPath(),
    userProfile: process.env.USERPROFILE || '',
  });
  const fromFiles = readEnvFiles(files);
  return { ...fromFiles, ...process.env };
}

function cleanProvider(id, provider) {
  const models = Array.isArray(provider.models)
    ? provider.models
        .filter((m) => m && m.id)
        .map((m) => ({
          id: String(m.id),
          name: m.name || '',
          context: m.context || null,
          // Явный флаг поддержки изображений (бэклог F1); без него — эвристика по имени.
          ...(typeof m.vision === 'boolean' ? { vision: m.vision } : {}),
          // Цена за 1 млн токенов для /cost (CC5.5); без неё показываются только токены.
          ...(m.price && Number.isFinite(Number(m.price.input)) ? { price: { input: Number(m.price.input), output: Number(m.price.output) || 0 } } : {}),
        }))
    : [];
  return {
    id,
    name: provider.name || id,
    baseURL: String(provider.baseURL || '').replace(/\/$/, ''),
    apiKey: provider.apiKey || '',
    userAgent: provider.userAgent || PROVIDER_USER_AGENT[id] || '',
    models,
  };
}

function bootstrapProviders(saved, env) {
  if (saved.providers && Object.keys(saved.providers).length) {
    const providers = {};
    for (const [id, provider] of Object.entries(saved.providers)) {
      providers[id] = cleanProvider(id, provider);
    }
    return providers;
  }

  // Миграция со старого формата: один шлюз в baseURL/apiKey/model.
  const baseURL = saved.baseURL || env.LLM_BASE_URL || 'https://api-ai.mai.ru/v1';
  const apiKey = saved.apiKey || env.LLM_API_KEY || readKeyFromDevFile();
  // Список чат-моделей MAI берём из STATIC_MODELS: одна модель из старого .env
  // не отражает реальный каталог шлюза.

  const providers = {
    mai: cleanProvider('mai', {
      name: 'MAI',
      baseURL,
      apiKey,
      models: STATIC_MODELS.mai,
    }),
  };

  if (env.AGENTROUTER_BASE_URL) {
    providers.agentrouter = cleanProvider('agentrouter', {
      name: 'AgentRouter',
      baseURL: env.AGENTROUTER_BASE_URL,
      apiKey: env.AGENTROUTER_API_KEY || '',
      models: STATIC_MODELS.agentrouter,
    });
  }

  return providers;
}

function bootstrapRuntimes(saved) {
  const base = RUNTIME_PRESETS;
  const runtimes = {};
  for (const [id, preset] of Object.entries(base)) {
    runtimes[id] = { ...preset, args: [...(preset.args || [])] };
  }
  for (const [id, runtime] of Object.entries(saved.runtimes || {})) {
    runtimes[id] = { ...(runtimes[id] || {}), ...runtime };
  }
  // Старые сохранения не знали про parser — дозаполняем из пресета.
  for (const [id, preset] of Object.entries(base)) {
    if (runtimes[id] && !runtimes[id].parser && preset.parser) runtimes[id].parser = preset.parser;
  }
  return runtimes;
}

/**
 * Секреты в settings.json шифруются хранилищем ОС (ADR 0031). На Linux без
 * keyring Electron использует basic_text — это шифр без ключа ОС, помечаем как weak.
 */
const secretBox = createSecretBox({
  available: () => safeStorage.isEncryptionAvailable(),
  weak: () => process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text',
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (buffer) => safeStorage.decryptString(buffer),
});

// Пути секретов, которые не удалось расшифровать при последнем чтении.
let unreadableSecrets = [];

function readRawSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeRawSettings(data) {
  const file = settingsPath();
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

/**
 * Шифрует секреты, которые лежат в settings.json открытым текстом
 * (файлы до ADR 0031). Вызывается после app.ready.
 */
export function migrateSecrets() {
  const raw = readRawSettings();
  const plain = plaintextSecrets(raw);
  if (!plain.length || !secretBox.available()) {
    return { migrated: 0, plaintext: plain, protection: secretBox.protection() };
  }
  writeRawSettings(sealSettings(raw, secretBox));
  return { migrated: plain.length, plaintext: plaintextSecrets(readRawSettings()), protection: secretBox.protection() };
}

export function secretsStatus() {
  return { protection: secretBox.protection(), plaintext: plaintextSecrets(readRawSettings()), unreadable: [...unreadableSecrets] };
}

export function loadSettings() {
  const opened = openSettings(readRawSettings(), secretBox);
  let saved = opened.settings;
  unreadableSecrets = opened.unreadable;

  const env = loadEnv();
  const providers = bootstrapProviders(saved, env);

  const settings = {
    ...DEFAULTS,
    ...saved,
    providers,
    runtimes: bootstrapRuntimes(saved),
    guardrails: { ...DEFAULT_GUARDRAILS, ...(saved.guardrails || {}) },
    shellSandbox: normalizeShellSandbox(saved.shellSandbox),
    permissions: {
      allow: Array.isArray(saved.permissions?.allow) ? saved.permissions.allow : [],
      ask: Array.isArray(saved.permissions?.ask) ? saved.permissions.ask : [],
      deny: Array.isArray(saved.permissions?.deny) ? saved.permissions.deny : [],
    },
    telemetry: { ...DEFAULTS.telemetry, ...(saved.telemetry || {}) },
    mas: { ...DEFAULTS.mas, ...(saved.mas || {}) },
    ocr: { ...DEFAULTS.ocr, ...(saved.ocr || {}) },
  };

  if (!settings.projectDir) {
    const desktop = path.join(process.env.USERPROFILE || '', 'Desktop');
    settings.projectDir = fs.existsSync(desktop) ? desktop : process.env.USERPROFILE || '';
  }

  if (!settings.activeModel) {
    const legacy = saved.model ? `mai/${saved.model}` : '';
    const fallbackModel = providers.mai?.models?.[0]?.id || 'deepseek-v4.1-flash';
    settings.activeModel = legacy || `mai/${fallbackModel}`;
  }

  return settings;
}

export function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch };

  if (patch.providers) {
    const providers = {};
    for (const [id, provider] of Object.entries(patch.providers)) {
      const previous = current.providers?.[id] || {};
      const merged = { ...provider };
      if (!merged.apiKey || merged.apiKey === '***') merged.apiKey = previous.apiKey || '';
      providers[id] = cleanProvider(id, merged);
    }
    next.providers = providers;
  }

  // Webhook уведомлений (CW5.4): окно видит «***» — такое значение не затирает настоящее.
  if (patch.notifications) {
    const previous = current.notifications || {};
    next.notifications = { ...previous, ...patch.notifications };
    if (patch.notifications.webhookUrl === '***') next.notifications.webhookUrl = previous.webhookUrl || '';
    // Каналы: «***» из окна — прежний токен/адрес того же канала (по id).
    if (Array.isArray(patch.notifications.channels)) {
      const old = new Map((previous.channels || []).map((c) => [c.id, c]));
      next.notifications.channels = patch.notifications.channels.map((c) => {
        const was = old.get(c.id) || {};
        // Старый одиночный webhook переехал в канал «legacy».
        const oldUrl = c.id === 'legacy' && !was.url ? previous.webhookUrl : was.url;
        return { ...c, ...(c.token === '***' ? { token: was.token || '' } : {}), ...(c.url === '***' ? { url: oldUrl || '' } : {}) };
      });
    }
  }

  if (patch.infra) {
    const previous = current.infra || {};
    next.infra = { ...previous, ...patch.infra };
    if (!next.infra.vaultToken || next.infra.vaultToken === '***') {
      next.infra.vaultToken = previous.vaultToken || '';
    }
  }

  // Окно видит заголовки и env MCP как «***»: при сохранении такие значения не затирают настоящие.
  if (patch.mcpServers) {
    const keep = (value, previous) => (value === '***' ? previous : value);
    next.mcpServers = Object.fromEntries(
      Object.entries(patch.mcpServers).map(([name, server]) => {
        const old = current.mcpServers?.[name] || {};
        const restore = (field) =>
          server?.[field] ? { [field]: Object.fromEntries(Object.entries(server[field]).map(([k, v]) => [k, keep(v, old[field]?.[k])]).filter(([, v]) => v !== undefined)) } : {};
        return [name, { ...server, ...restore('headers'), ...restore('env') }];
      }),
    );
  }

  if (patch.webSearch) {
    const provider = ['duckduckgo', 'searxng', 'brave'].includes(patch.webSearch.provider) ? patch.webSearch.provider : current.webSearch?.provider || 'duckduckgo';
    const apiKey = patch.webSearch.apiKey === '***' || patch.webSearch.apiKey === undefined ? current.webSearch?.apiKey || '' : String(patch.webSearch.apiKey);
    next.webSearch = { provider, url: String(patch.webSearch.url ?? current.webSearch?.url ?? ''), apiKey, allowPrivate: patch.webSearch.allowPrivate === true };
  }

  if (patch.repowise) {
    next.repowise = { ...(current.repowise || {}), ...patch.repowise };
  }

  if (patch.shellSandbox) {
    next.shellSandbox = normalizeShellSandbox({ ...(current.shellSandbox || {}), ...patch.shellSandbox });
  }

  if (patch.guardrails) {
    next.guardrails = { ...(current.guardrails || DEFAULT_GUARDRAILS), ...patch.guardrails };
  }

  if (patch.telemetry) {
    next.telemetry = { ...(current.telemetry || DEFAULTS.telemetry), ...patch.telemetry };
  }

  if (patch.ocr) {
    next.ocr = { ...(current.ocr || DEFAULTS.ocr), ...patch.ocr };
  }

  if (patch.mas) {
    const previous = current.mas || DEFAULTS.mas;
    next.mas = { ...previous, ...patch.mas };
    if (!next.mas.token || next.mas.token === '***') next.mas.token = previous.token || '';
  }

  // После миграции на реестр провайдеров старые поля не нужны (и не должны лежать открытым ключом).
  if (next.providers && Object.keys(next.providers).length) {
    delete next.apiKey;
    delete next.baseURL;
    delete next.model;
  }

  // На диск — с зашифрованными секретами; в памяти main остаются открытые значения.
  writeRawSettings(keepUnreadable(sealSettings(next, secretBox), readRawSettings(), unreadableSecrets));
  return next;
}

export function publicSettings() {
  const s = loadSettings();
  const providers = {};
  for (const [id, provider] of Object.entries(s.providers)) {
    providers[id] = {
      ...provider,
      apiKey: provider.apiKey ? '***' : '',
      apiKeySet: Boolean(provider.apiKey),
      keyHint: provider.apiKey ? provider.apiKey.slice(0, 6) : '',
    };
  }
  const safe = { ...s, providers };
  safe.infra = {
    ...(s.infra || {}),
    vaultToken: s.infra?.vaultToken ? '***' : '',
    vaultTokenSet: Boolean(s.infra?.vaultToken),
  };
  safe.notifications = {
    ...(s.notifications || DEFAULTS.notifications),
    webhookUrl: s.notifications?.webhookUrl ? '***' : '',
    webhookSet: Boolean(s.notifications?.webhookUrl),
    // Токены ботов и адреса webhook окно видит как «***».
    channels: (s.notifications?.channels || []).map((c) => ({ ...c, ...(c.token ? { token: '***' } : {}), ...(c.url ? { url: '***' } : {}) })),
  };
  safe.mas = {
    ...(s.mas || DEFAULTS.mas),
    token: s.mas?.token ? '***' : '',
    tokenSet: Boolean(s.mas?.token),
  };
  safe.webSearch = { ...(s.webSearch || {}), apiKey: s.webSearch?.apiKey ? '***' : '', apiKeySet: Boolean(s.webSearch?.apiKey) };
  // Заголовки и env MCP-серверов — наружу только факт наличия (ADR 0052).
  safe.mcpServers = Object.fromEntries(
    Object.entries(s.mcpServers || {}).map(([name, server]) => [
      name,
      {
        ...server,
        ...(server?.headers ? { headers: Object.fromEntries(Object.keys(server.headers).map((k) => [k, '***'])) } : {}),
        ...(server?.env ? { env: Object.fromEntries(Object.keys(server.env).map((k) => [k, '***'])) } : {}),
      },
    ]),
  );
  const secrets = secretsStatus();
  safe.secretsProtection = secrets.protection;
  safe.secretsPlaintext = secrets.plaintext.length;
  safe.secretsUnreadable = secrets.unreadable;
  // Старый формат хранил ключ в корне настроек — наружу его не отдаём.
  delete safe.apiKey;
  delete safe.baseURL;
  delete safe.model;
  return safe;
}

export { dataDir, STATIC_MODELS, secretBox };
