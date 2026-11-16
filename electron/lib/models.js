import { loadSettings, providerUserAgent } from './config.js';

const cache = new Map(); // providerId -> { at, baseURL, data }
const TTL = 5 * 60 * 1000;
const FETCH_TIMEOUT = 8000;

// Читаемые названия: у MAI в /v1/models нет поля name.
const PRETTY_NAMES = {
  'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
  'DeepSeek-V4-Flash': 'DeepSeek V4 Flash',
  'Qwen3.5-122B-A10B': 'Qwen 3.5 122B A10B',
  'qwen3.8-27b': 'Qwen 3.8 27B',
  'qwen3.8-flash-next': 'Qwen 3.8 Flash Next',
  'qwen3.6-35b-a3b': 'Qwen 3.6 35B A3B',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
};

export function prettyName(id) {
  if (PRETTY_NAMES[id]) return PRETTY_NAMES[id];
  return String(id || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .trim();
}

export function isChatModel(model) {
  if (model.mode) return model.mode === 'chat';
  return /deepseek|qwen|gpt|claude|llama|mistral|gemma|glm|opus|sonnet/i.test(model.id || '');
}

function fromStatic(providerId, provider) {
  return (provider.models || [])
    .filter((m) => m.id)
    .map((m) => ({
      key: `${providerId}/${m.id}`,
      provider: providerId,
      providerName: provider.name || providerId,
      id: m.id,
      name: m.name || prettyName(m.id),
      context: m.context || null,
    }));
}

async function fetchProviderModels(providerId, provider, force) {
  const cached = cache.get(providerId);
  if (
    !force &&
    cached &&
    cached.baseURL === provider.baseURL &&
    Date.now() - cached.at < TTL
  ) {
    return cached.data;
  }

  const staticModels = fromStatic(providerId, provider);

  if (!provider.baseURL) return staticModels;

  try {
    const res = await fetch(`${provider.baseURL}/models`, {
      headers: {
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        ...(providerUserAgent(providerId, provider)
          ? { 'User-Agent': providerUserAgent(providerId, provider) }
          : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const models = (body.data || [])
      .filter(isChatModel)
      .map((m) => ({
        key: `${providerId}/${m.id}`,
        provider: providerId,
        providerName: provider.name || providerId,
        id: m.id,
        name: m.name || prettyName(m.id),
        context: m.max_input_tokens || m.context_length || null,
      }))
      .sort((a, b) => (b.context || 0) - (a.context || 0) || a.id.localeCompare(b.id));

    if (!models.length) throw new Error('шлюз не вернул чат-моделей');
    cache.set(providerId, { at: Date.now(), baseURL: provider.baseURL, data: models });
    return models;
  } catch (err) {
    if (staticModels.length) {
      cache.set(providerId, { at: Date.now(), baseURL: provider.baseURL, data: staticModels });
      return staticModels;
    }
    throw err;
  }
}

/** Все модели всех провайдеров в виде provider/model. */
export async function listModels({ force = false } = {}) {
  const settings = loadSettings();
  const models = [];
  const errors = {};

  for (const [providerId, provider] of Object.entries(settings.providers)) {
    try {
      models.push(...(await fetchProviderModels(providerId, provider, force)));
    } catch (err) {
      errors[providerId] = err?.message || String(err);
    }
  }

  return { models, errors };
}

/** Разбирает "provider/model" в провайдера и голый id модели. */
export function resolveModel(settings, key) {
  const value = String(key || '');
  const slash = value.indexOf('/');

  if (slash === -1) {
    const provider = settings.providers.mai;
    if (!provider) throw new Error('Провайдер MAI не настроен');
    return { providerId: 'mai', modelId: value, provider };
  }

  const providerId = value.slice(0, slash);
  const modelId = value.slice(slash + 1);
  const provider = settings.providers[providerId];
  if (!provider) throw new Error(`Провайдер «${providerId}» не найден`);
  return { providerId, modelId, provider };
}
