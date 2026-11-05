import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { envCandidates, readEnvFiles } from './env.js';
import { RUNTIME_PRESETS } from './runtimes.js';

const DEFAULTS = {
  temperature: 0.3,
  maxIterations: 30,
  autoApproveShell: false,
  allowOutsideProject: false,
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
};

// Модели, которые показываем, если шлюз не отдал /models.
const STATIC_MODELS = {
  agentrouter: [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', context: 200000 },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', context: 200000 },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', context: 1000000 },
  ],
};

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
        .map((m) => ({ id: String(m.id), name: m.name || '', context: m.context || null }))
    : [];
  return {
    id,
    name: provider.name || id,
    baseURL: String(provider.baseURL || '').replace(/\/$/, ''),
    apiKey: provider.apiKey || '',
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
  const model = saved.model || env.LLM_MODEL || 'deepseek-v4.1-flash';

  const providers = {
    mai: cleanProvider('mai', {
      name: 'MAI',
      baseURL,
      apiKey,
      models: [{ id: model, name: '', context: null }],
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
  const runtimes = { ...base, ...(saved.runtimes || {}) };
  // Старые сохранения не знали про parser — дозаполняем из пресета.
  for (const [id, preset] of Object.entries(base)) {
    if (runtimes[id] && !runtimes[id].parser && preset.parser) runtimes[id].parser = preset.parser;
  }
  return runtimes;
}

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    saved = {};
  }

  const env = loadEnv();
  const providers = bootstrapProviders(saved, env);

  const settings = {
    ...DEFAULTS,
    ...saved,
    providers,
    runtimes: bootstrapRuntimes(saved),
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

  if (patch.infra) {
    const previous = current.infra || {};
    next.infra = { ...previous, ...patch.infra };
    if (!next.infra.vaultToken || next.infra.vaultToken === '***') {
      next.infra.vaultToken = previous.vaultToken || '';
    }
  }

  if (patch.repowise) {
    next.repowise = { ...(current.repowise || {}), ...patch.repowise };
  }

  // После миграции на реестр провайдеров старые поля не нужны (и не должны лежать открытым ключом).
  if (next.providers && Object.keys(next.providers).length) {
    delete next.apiKey;
    delete next.baseURL;
    delete next.model;
  }

  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
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
  // Старый формат хранил ключ в корне настроек — наружу его не отдаём.
  delete safe.apiKey;
  delete safe.baseURL;
  delete safe.model;
  return safe;
}

export { dataDir, STATIC_MODELS };
